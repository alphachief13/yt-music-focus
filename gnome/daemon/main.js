#!/usr/bin/env -S gjs -m
// Focus — local player for the GNOME panel (only with the panel installed).
//
// Plays the Focus queue without the browser: a hidden WebKitGTK view on
// www.youtube.com, with Focus's own ad handling (src/shared.js + src/ads.js)
// injected. Built on yt-pod's daemon (WebKit setup, hidden-page tricks, page
// bridge). It serves the same D-Bus interface as the native host, so the
// panel doesn't care which one is answering.
//
// Who owns io.github.alphachief13.YtFocus:
//   browser open + Focus playing  -> the native host (host/focus-host.js)
//   browser closed                -> this player (started by the host on exit,
//                                    or by the panel on demand)
// The host takes the name back (REPLACE) as soon as a Focus tab plays; this
// process then pauses, saves the session and exits.
//
//   gjs -m main.js            idle, shows the last song paused
//   gjs -m main.js --resume   continue the last session right away
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import WebKit from 'gi://WebKit?version=6.0';

import {IFACE_XML, BUS_NAME, OBJECT_PATH} from '../common/iface.js';
import {BASE, ID_RE, readJson, writeJson, libraryView, applyOp, addPending, cleanTrack} from '../common/store.js';
import {ensureThumb, thumbNow} from '../common/thumbs.js';
import {search, parseTitle} from '../common/search.js';

const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
// Safari UA: with a Chrome UA YouTube picks a streaming mode WebKit can't
// sustain and audio stalls after ~1 min of buffer (found in yt-pod).
const WEB_USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const LOAD_TIMEOUT_S = 15;
const IDLE_QUIT_S = 15 * 60;
const DEBUG = !!GLib.getenv('YTFOCUS_DEBUG');
const log = (...a) => printerr(`yt-focus player: ${a.join(' ')}`);

function readText(...candidates) {
    for (const path of candidates) {
        try {
            const [, bytes] = GLib.file_get_contents(path);
            return new TextDecoder().decode(bytes);
        } catch (_) { /* next */ }
    }
    return null;
}

// Page scripts: ./page/* (installed copies of src/ files), or straight from
// the repository's src/ when running from a checkout.
function pageAsset(name) {
    return readText(
        GLib.build_filenamev([HERE, 'page', name]),
        GLib.build_filenamev([HERE, '..', '..', 'src', name]));
}

// Nothing is shown: skip rendering the parts of the watch page we never see.
const QUIET_CSS = `
ytd-watch-flexy #secondary, ytd-watch-flexy #below, ytd-comments, #masthead-container,
tp-yt-app-drawer, ytd-mini-guide-renderer, ytd-watch-flexy #chat { display: none !important; }`;

class Player {
    constructor(app, resume) {
        this.app = app;
        this.resume = resume;
        this.view = null;
        this.window = null;
        this.pageReady = false;

        this.library = libraryView();
        this.results = [];
        const s = readJson('session.json', {}) || {};
        this.track = cleanTrack(s) ? {...cleanTrack(s)} : null;
        this.position = Number(s.position) || 0;
        this.length = Number(s.duration) || this.track?.duration || 0;
        this.volume = Number.isFinite(s.volume) ? Math.max(0, Math.min(100, s.volume)) : 70;
        this.queue = Array.isArray(s.queue) ? s.queue.filter(id => ID_RE.test(id)) : [];
        this.history = [];
        this.status = this.track ? 'paused' : 'idle';
        this.loadingId = null;
        this.loadTimer = 0;
        this.recorded = null;
        this.idleSince = Date.now();
        this.quitting = false;
    }

    // -----------------------------------------------------------------------
    // WebKit (from yt-pod)
    // -----------------------------------------------------------------------

    _ensureView() {
        if (this.view)
            return;
        const session = new WebKit.NetworkSession({
            data_directory: GLib.build_filenamev([BASE, 'web']),
            cache_directory: GLib.build_filenamev([GLib.get_user_cache_dir(), 'yt-focus', 'web']),
        });
        session.get_cookie_manager().set_persistent_storage(
            GLib.build_filenamev([BASE, 'cookies.sqlite']), WebKit.CookiePersistentStorage.SQLITE);

        const ucm = new WebKit.UserContentManager();
        const top = WebKit.UserContentInjectedFrames.TOP_FRAME;
        const start = WebKit.UserScriptInjectionTime.START;
        const end = WebKit.UserScriptInjectionTime.END;
        const script = (code, when) => code && ucm.add_script(new WebKit.UserScript(code, top, when, null, null));
        const style = code => code && ucm.add_style_sheet(new WebKit.UserStyleSheet(code, top, WebKit.UserStyleLevel.USER, null, null));

        script(pageAsset('visibility.js'), start);
        style(pageAsset('ads.css'));
        style(QUIET_CSS);
        // Focus's ad handling (yt-ads-sucks port) — same code as in the browser.
        const shared = pageAsset('shared.js');
        const ads = pageAsset('ads.js');
        if (!shared || !ads)
            log('shared.js/ads.js not found: ads will not be skipped');
        script(shared, end);
        script(ads, end);
        script(pageAsset('bridge.js'), end);

        ucm.register_script_message_handler('ytfocus', null);
        ucm.connect('script-message-received::ytfocus', (_m, value) => {
            try {
                this._onPage(JSON.parse(value.to_string()));
            } catch (e) {
                log(`bad page message: ${e.message}`);
            }
        });

        this.view = new WebKit.WebView({
            network_session: session,
            user_content_manager: ucm,
            website_policies: new WebKit.WebsitePolicies({autoplay: WebKit.AutoplayPolicy.ALLOW}),
            hexpand: true,
            vexpand: true,
        });
        if (GLib.getenv('YTFOCUS_TEST_MUTE'))
            this.view.is_muted = true; // tests: never make a sound
        const settings = this.view.get_settings();
        settings.set_user_agent(WEB_USER_AGENT);
        settings.set_enable_write_console_messages_to_stdout(DEBUG);
        settings.set_media_playback_requires_user_gesture(false);
        settings.set_enable_mediasource(true);
        settings.set_enable_webaudio(true);

        // The window stays hidden: turn off WebKit's savings for invisible
        // pages, or the player stops fetching audio after its buffer.
        const off = new Set([
            'HiddenPageDOMTimerThrottling', 'HiddenPageDOMTimerThrottlingAutoIncreases',
            'DOMTimersThrottling', 'PageVisibilityBasedProcessSuppression',
            'HiddenPageCSSAnimationSuspension', 'RequiresPageVisibilityToPlayAudio',
            'InterruptAudioOnPageVisibilityChange', 'InvisibleAutoplayNotPermitted',
        ]);
        const features = WebKit.Settings.get_all_features();
        for (let i = 0; i < features.get_length(); i++) {
            const f = features.get(i);
            if (off.has(f.get_identifier()))
                settings.set_feature_enabled(f, false);
        }

        this.view.connect('load-changed', (_v, ev) => {
            if (ev === WebKit.LoadEvent.STARTED)
                this.pageReady = false;
        });
        this.view.connect('web-process-terminated', () => {
            log('web process died, reloading');
            this.pageReady = false;
            if (this.track && this.status !== 'paused')
                this._loadUrl(this.track.videoId, this.position);
        });
        this.view.connect('create', (view, action) => {
            const req = action.get_request();
            if (req)
                view.load_request(req);
            return null;
        });

        // Only shown for the optional YouTube login.
        this.window = new Adw.ApplicationWindow({
            application: this.app,
            title: 'Focus · YouTube',
            default_width: 1100,
            default_height: 760,
            hide_on_close: true,
        });
        const header = new Adw.HeaderBar({
            title_widget: new Adw.WindowTitle({
                title: 'Focus',
                subtitle: 'Login opcional — feche a janela e a música continua',
            }),
        });
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(header);
        toolbar.set_content(this.view);
        this.window.set_content(toolbar);
    }

    _js(code, cb = null) {
        if (!this.view)
            return cb?.(null);
        this.view.evaluate_javascript(code, -1, null, null, null, (view, res) => {
            let value = null;
            try {
                value = view.evaluate_javascript_finish(res);
            } catch (_) { /* page loading */ }
            cb?.(value);
        });
    }

    _page(method, ...args) {
        const a = args.map(x => JSON.stringify(x)).join(',');
        this._js(`window.__yf && window.__yf.${method}(${a}); true`);
    }

    _loadUrl(id, start = 0) {
        this._ensureView();
        this.pageReady = false;
        const t = Math.floor(start) > 0 ? `&t=${Math.floor(start)}s` : '';
        this.view.load_uri(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}${t}`);
    }

    // -----------------------------------------------------------------------
    // Page -> player
    // -----------------------------------------------------------------------

    _onPage(m) {
        switch (m.type) {
        case 'ready':
            this.pageReady = true;
            this._page('config', {volume: this.volume, play: this.status !== 'paused'});
            break;
        case 'ended':
            if (this.track && m.videoId === this.track.videoId)
                this._advance(true);
            break;
        case 'state':
            this._onPageState(m);
            break;
        }
    }

    _onPageState(s) {
        if (DEBUG)
            log(`page: ${JSON.stringify(s)} loading=${this.loadingId} status=${this.status}`);
        if (s.ad && this.loadingId) {
            // An ad means the song is on its way: don't reload the page under it.
            this._clearLoadTimer();
        }
        if (this.loadingId) {
            if (s.videoId !== this.loadingId && !s.ad)
                return; // still the previous song
            if (s.videoId === this.loadingId && (s.playing || s.ad)) {
                this.loadingId = null;
                this._clearLoadTimer();
            }
        }
        // YouTube moved on by itself (up next): follow it.
        if (s.videoId && ID_RE.test(s.videoId) && !s.ad && this.track?.videoId !== s.videoId && !this.loadingId)
            this._setTrack({videoId: s.videoId, title: '', artist: '', duration: 0});

        if (this.track && !s.ad && s.title && (!this.track.title || this.track.title === this.track.videoId)) {
            const {title, artist} = parseTitle(s.title, s.author);
            this.track = {...this.track, title, artist: this.track.artist || artist};
        }
        if (s.ad)
            this.status = 'ad';
        else if (!this.loadingId)
            this.status = s.playing ? 'playing' : 'paused';
        if (!s.ad && !this.loadingId) {
            this.position = s.position;
            if (s.length > 0)
                this.length = s.length;
        }
        if (this.status === 'playing')
            this.idleSince = Date.now();
        if (this.status === 'playing' && this.track?.title && this.recorded !== this.track.videoId) {
            this.recorded = this.track.videoId;
            this._libOp({op: 'played', track: {...this.track, duration: Math.round(this.length) || this.track.duration}});
        }
        this._emitState();
        this._saveSessionSoon();
    }

    // -----------------------------------------------------------------------
    // Queue / playback
    // -----------------------------------------------------------------------

    _known(id) {
        const all = [...this.results, ...this.library.liked, ...this.library.recent, ...this.library.playlists.flatMap(p => p.tracks)];
        return all.find(t => t.videoId === id) || {videoId: id, title: '', artist: '', duration: 0};
    }

    _setTrack(t) {
        if (this.track?.videoId && this.track.videoId !== t.videoId)
            this.history.push(this.track.videoId);
        this.track = {...t};
        this.length = t.duration || 0;
        ensureThumb(t.videoId).then(() => this._emitState());
    }

    _clearLoadTimer() {
        if (this.loadTimer)
            GLib.source_remove(this.loadTimer);
        this.loadTimer = 0;
    }

    _start(id, start = 0) {
        if (!ID_RE.test(id || ''))
            return;
        if (this.track?.videoId !== id)
            this._setTrack(this._known(id));
        this.status = 'loading';
        this.position = start;
        this.loadingId = id;
        this.idleSince = Date.now();
        this._emitState();

        const fallback = () => this.loadingId === id && this._loadUrl(id, start);
        if (this.pageReady) {
            this._js(`!!(window.__yf && window.__yf.load(${JSON.stringify(id)}, ${Number(start) || 0}))`, v => {
                if (!v?.to_boolean())
                    fallback();
            });
        } else {
            fallback();
        }

        // Nothing playing after a while: reload the page once, then skip.
        this._clearLoadTimer();
        let retried = false;
        this.loadTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LOAD_TIMEOUT_S, () => {
            if (this.loadingId !== id) {
                this.loadTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (!retried) {
                retried = true;
                this._loadUrl(id, start);
                return GLib.SOURCE_CONTINUE;
            }
            this.loadTimer = 0;
            log(`${id} did not load, skipping`);
            this.loadingId = null;
            this._advance(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    play(ids, index) {
        ids = ids.filter(id => ID_RE.test(id)).slice(0, 500);
        if (!ids.length)
            return;
        this.queue = ids;
        this._start(ids[Math.max(0, Math.min(index, ids.length - 1))], 0);
    }

    _advance(auto) {
        const i = this.track ? this.queue.indexOf(this.track.videoId) : -1;
        if (i >= 0 && i < this.queue.length - 1)
            return this._start(this.queue[i + 1], 0);
        // No queue (or its end): YouTube's own "up next", like Focus in the browser.
        if (!this.queue.length || !auto) {
            if (this.pageReady) {
                this.status = 'loading';
                this.loadingId = null;
                this._page('next');
                this._emitState();
            }
            return;
        }
        this.status = 'paused';
        this._emitState();
    }

    next() {
        this._advance(false);
    }

    previous() {
        if (this.position > 3)
            return this.seek(0);
        const i = this.track ? this.queue.indexOf(this.track.videoId) : -1;
        if (i > 0)
            return this._start(this.queue[i - 1], 0);
        const prev = this.history.pop();
        if (prev) {
            this.track = null; // don't push the current one back
            return this._start(prev, 0);
        }
        this.seek(0);
    }

    toggle() {
        if (!this.track)
            return;
        if (!this.view || (!this.pageReady && !this.loadingId)) {
            // Nothing loaded yet (idle start): continue the session from where it stopped.
            const at = this.length > 0 && this.length - this.position < 2 ? 0 : this.position;
            return this._start(this.track.videoId, at);
        }
        if (this.status === 'playing' || this.status === 'loading' || this.status === 'ad') {
            this.status = 'paused';
            this.loadingId = null;
            this._clearLoadTimer();
            this._page('pause');
        } else {
            this.status = 'playing';
            this._page('play');
        }
        this._emitState();
    }

    pause() {
        if (this.status !== 'paused' && this.status !== 'idle') {
            this.status = 'paused';
            this._page('pause');
        }
    }

    seek(t) {
        if (!this.pageReady) {
            this.position = Math.max(0, t);
            return this._emitState();
        }
        this._page('seek', Math.max(0, t));
    }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(100, Math.round(v)));
        this._page('setVolume', this.volume);
        this._emitState();
        this._saveSessionSoon();
    }

    /** Hand the song back to the browser, at the current position. */
    showBrowser() {
        const id = this.track?.videoId;
        const t = Math.floor(this.position);
        const url = id ? `https://www.youtube.com/watch?v=${id}${t > 0 ? `&t=${t}s` : ''}` : 'https://www.youtube.com/';
        this.pause();
        this._saveSession();
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            log(`open browser: ${e.message}`);
        }
        this._emitState();
    }

    // -----------------------------------------------------------------------
    // Library (mirror of the browser's + pending edits)
    // -----------------------------------------------------------------------

    _libOp(op) {
        addPending(op);
        this.library = applyOp(this.library, op);
        this._emitLibrary();
        this._emitState();
    }

    _liked(id) {
        return this.library.liked.some(t => t.videoId === id);
    }

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    stateJson() {
        const t = this.track;
        return JSON.stringify({
            connected: true,
            backend: 'local',
            track: t ? {videoId: t.videoId, title: t.title || '', artist: t.artist || '', thumbFile: thumbNow(t.videoId, () => this._emitState())} : null,
            status: t ? this.status : 'idle',
            position: this.position,
            length: this.length,
            volume: this.volume,
            muted: false,
            liked: !!t && this._liked(t.videoId),
            videoMode: this.library.settings.videoMode,
            focus: this.library.settings.focus,
        });
    }

    libraryJson() {
        const later = () => this._emitLibrarySoon();
        const withThumb = t => ({...t, thumbFile: thumbNow(t.videoId, later)});
        const l = this.library;
        return JSON.stringify({
            liked: l.liked.map(withThumb),
            playlists: l.playlists.map(p => ({...p, tracks: p.tracks.map(withThumb)})),
            recent: l.recent.map(withThumb),
        });
    }

    _emit(name, json) {
        this.dbus?.emit_signal(name, new GLib.Variant('(s)', [json]));
    }

    _emitState() {
        this._emit('StateChanged', this.stateJson());
    }

    _emitLibrary() {
        this._emit('LibraryChanged', this.libraryJson());
    }

    _emitLibrarySoon() {
        if (this._libTimer)
            return;
        this._libTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._libTimer = 0;
            this._emitLibrary();
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveSession() {
        if (!this.track)
            return;
        writeJson('session.json', {
            ...this.track,
            duration: Math.round(this.length) || this.track.duration || 0,
            position: Math.floor(this.position),
            playing: this.status === 'playing' || this.status === 'ad',
            queue: this.queue,
            volume: this.volume,
            at: Date.now(),
            by: 'local',
        });
    }

    _saveSessionSoon() {
        if (this._sessTimer)
            return;
        this._sessTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._sessTimer = 0;
            this._saveSession();
            return GLib.SOURCE_REMOVE;
        });
    }

    // -----------------------------------------------------------------------
    // D-Bus
    // -----------------------------------------------------------------------

    impl() {
        const self = this;
        const fail = (inv, e) => inv.return_error_literal(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED, String(e?.message || e));
        const track = json => {
            const t = cleanTrack(JSON.parse(json));
            if (!t)
                throw new Error('invalid track');
            return t;
        };
        return {
            GetState: () => self.stateJson(),
            GetLibrary: () => self.libraryJson(),
            SearchAsync([query], inv) {
                search(query)
                    .then(items => {
                        self.results = items;
                        return Promise.all(items.map(t => ensureThumb(t.videoId).then(f => ({...t, thumbFile: f}))));
                    })
                    .then(items => inv.return_value(new GLib.Variant('(s)', [JSON.stringify(items)])))
                    .catch(e => fail(inv, e));
            },
            Play: (idsJson, index) => self.play(JSON.parse(idsJson), index),
            Toggle: () => self.toggle(),
            Next: () => self.next(),
            Previous: () => self.previous(),
            Seek: t => self.seek(t),
            SetVolume: v => self.setVolume(v),
            ToggleLikeCurrent: () => {
                const t = self.track;
                if (!t)
                    return;
                self._libOp(self._liked(t.videoId) ? {op: 'unlike', id: t.videoId}
                    : {op: 'like', track: {...t, duration: Math.round(self.length) || t.duration}});
            },
            Like: json => self._libOp({op: 'like', track: track(json)}),
            Unlike: id => self._libOp({op: 'unlike', id}),
            CreatePlaylist: name => {
                const id = `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
                self._libOp({op: 'createPlaylist', id, name: String(name).slice(0, 80)});
                return id;
            },
            DeletePlaylist: id => self._libOp({op: 'deletePlaylist', id}),
            AddToPlaylist: (id, json) => self._libOp({op: 'addToPlaylist', id, track: track(json)}),
            RemoveFromPlaylist: (id, videoId) => self._libOp({op: 'removeFromPlaylist', id, videoId}),
            SetVideoMode: mode => self._libOp({op: 'setting', key: 'videoMode', value: mode}),
            SetFocus: on => self._libOp({op: 'setting', key: 'focus', value: !!on}),
            ShowBrowser: () => self.showBrowser(),
            ShowWindow: () => {
                self._ensureView();
                if (!self.pageReady && !self.loadingId)
                    self.view.load_uri('https://www.youtube.com/');
                self.window.present();
            },
            Quit: () => self.quit('requested'),
        };
    }

    exportOn(connection) {
        let xml = IFACE_XML;
        const impl = this.impl();
        if (DEBUG) {
            // Development only: run JS in the page and return the result.
            xml = xml.replace('<method name="Quit"/>',
                '<method name="Quit"/><method name="Eval"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>');
            impl.EvalAsync = ([code], inv) => this._js(`JSON.stringify((() => { ${code} })())`, v =>
                inv.return_value(new GLib.Variant('(s)', [v?.to_string() ?? 'null'])));
        }
        this.dbus = Gio.DBusExportedObject.wrapJSObject(xml, impl);
        this.dbus.export(connection, OBJECT_PATH);
    }

    start() {
        this._emitState();
        this._emitLibrary();
        if (this.resume && this.track) {
            log(`resuming ${this.track.videoId} at ${Math.floor(this.position)}s`);
            this._start(this.track.videoId, this.position);
        }
        // Free the memory when nothing has played for a while.
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            const idle = this.status !== 'playing' && this.status !== 'loading' && this.status !== 'ad';
            if (idle && Date.now() - this.idleSince > IDLE_QUIT_S * 1000)
                this.quit('idle');
            return GLib.SOURCE_CONTINUE;
        });
    }

    quit(reason) {
        if (this.quitting)
            return;
        this.quitting = true;
        log(`quitting (${reason})`);
        if (this.status === 'playing' || this.status === 'ad' || this.status === 'loading')
            this._page('pause');
        if (this.status !== 'idle')
            this.status = 'paused';
        // Replaced = the browser took over and now owns session.json.
        if (reason !== 'replaced' && reason !== 'name taken')
            this._saveSession();
        // Give the pause a moment to reach the page before the process goes.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this.app.release();
            this.app.quit();
            return GLib.SOURCE_REMOVE;
        });
    }
}

const PlayerApp = GObject.registerClass(class PlayerApp extends Adw.Application {
    constructor(resume) {
        // NON_UNIQUE: the well-known bus name is owned by hand below, with
        // replacement allowed so the browser can take it back.
        super({application_id: 'io.github.alphachief13.YtFocus.Player', flags: Gio.ApplicationFlags.NON_UNIQUE});
        this.resume = resume;
    }

    vfunc_startup() {
        super.vfunc_startup();
        this.hold();
        this.player = new Player(this, this.resume);
        this.ownerId = Gio.bus_own_name(
            Gio.BusType.SESSION, BUS_NAME,
            Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.DO_NOT_QUEUE,
            conn => this.player.exportOn(conn),
            () => this.player.start(),
            () => this.player.quit(this.player.dbus ? 'replaced' : 'name taken'));
        // After the name: on a fresh session bus this may wait on the portal.
        Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.PREFER_DARK);
    }

    vfunc_activate() {}

    vfunc_shutdown() {
        if (this.ownerId)
            Gio.bus_unown_name(this.ownerId);
        this.player?.dbus?.unexport();
        super.vfunc_shutdown();
    }
});

new PlayerApp(ARGV.includes('--resume')).run([]);
