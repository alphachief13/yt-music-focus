// Focus — GNOME panel for the Focus Chrome extension.
//
// Mirrors what the Focus tab is playing and controls it. There is no player
// here: the native host (host/focus-host.js), started by the browser when the
// desktop integration is enabled, relays state/commands over D-Bus.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {IFACE_XML, BUS_NAME, OBJECT_PATH} from './iface.js';

const FocusProxy = Gio.DBusProxy.makeProxyWrapper(IFACE_XML);
const VERTICAL = Clutter.Orientation.VERTICAL;
const ID_RE = /^[\w-]{11}$/;

const PT = (GLib.get_language_names()[0] || '').startsWith('pt');
const T = PT ? {
    nothing: 'Nada tocando', nothingSub: 'Toque uma música no Focus',
    offline: 'Focus desconectado', offlineSub: 'Abra o YouTube no navegador',
    search: 'Buscar', liked: 'Curtidas', playlists: 'Playlists', recent: 'Recentes',
    searchHint: 'Buscar no YouTube…', typeEnter: 'Digite e aperte Enter', searching: 'Buscando…',
    searchFail: 'Não foi possível buscar agora', needBrowser: 'A busca usa a aba do Focus',
    likeHint: 'Toque no ♥ para curtir músicas', emptyRecent: 'Nada tocado ainda',
    newPlaylist: 'Nova playlist…', firstPlaylist: 'Crie sua primeira playlist acima',
    useAdd: 'Use o + nas músicas para adicionar', add: t => `Adicionar “${t}”`, added: t => `Adicionada: ${t}`,
    songs: n => `${n} música${n === 1 ? '' : 's'}`, likedN: n => `${n} curtida${n === 1 ? '' : 's'}`,
    ad: 'Anúncio silenciado e pulando…', adStatus: 'Pulando anúncio…',
    connected: 'Focus · navegador conectado', offlineStatus: 'Ative o painel nos ajustes do Focus',
    play: 'Tocar', pause: 'Pausar', prev: 'Anterior', next: 'Próxima', like: 'Curtir', unlike: 'Descurtir',
    shuffle: 'Tocar aleatório', playAll: 'Tocar tudo', del: 'Apagar playlist', back: 'Voltar',
    remove: 'Remover da playlist', addTo: 'Adicionar a uma playlist', browser: 'Abrir a aba do Focus',
    mode: {video: 'Vídeo ligado', cover: 'Só a capa', dark: 'Escuro'}, focusOn: 'Modo Focus ligado', focusOff: 'Modo Focus desligado',
    position: 'Posição', volume: 'Volume',
} : {
    nothing: 'Nothing playing', nothingSub: 'Play a song in Focus',
    offline: 'Focus disconnected', offlineSub: 'Open YouTube in the browser',
    search: 'Search', liked: 'Liked', playlists: 'Playlists', recent: 'Recent',
    searchHint: 'Search YouTube…', typeEnter: 'Type and press Enter', searching: 'Searching…',
    searchFail: "Couldn't search right now", needBrowser: 'Search goes through the Focus tab',
    likeHint: 'Tap ♥ to like songs', emptyRecent: 'Nothing played yet',
    newPlaylist: 'New playlist…', firstPlaylist: 'Create your first playlist above',
    useAdd: 'Use + on songs to add them', add: t => `Add “${t}”`, added: t => `Added: ${t}`,
    songs: n => `${n} song${n === 1 ? '' : 's'}`, likedN: n => `${n} liked`,
    ad: 'Ad muted and skipping…', adStatus: 'Skipping ad…',
    connected: 'Focus · browser connected', offlineStatus: 'Enable the panel in Focus settings',
    play: 'Play', pause: 'Pause', prev: 'Previous', next: 'Next', like: 'Like', unlike: 'Unlike',
    shuffle: 'Shuffle', playAll: 'Play all', del: 'Delete playlist', back: 'Back',
    remove: 'Remove from playlist', addTo: 'Add to a playlist', browser: 'Open the Focus tab',
    mode: {video: 'Video on', cover: 'Cover only', dark: 'Dark'}, focusOn: 'Focus mode on', focusOff: 'Focus mode off',
    position: 'Position', volume: 'Volume',
};

const MODES = ['video', 'cover', 'dark'];
const MODE_ICON = {video: 'video-display-symbolic', cover: 'image-x-generic-symbolic', dark: 'weather-clear-night-symbolic'};

function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0)
        sec = 0;
    sec = Math.floor(sec);
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function label(text, styleClass, extra = {}) {
    const l = new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...extra});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

let ICON_DIR = '';
const fileIcon = name => Gio.FileIcon.new(Gio.File.new_for_path(`${ICON_DIR}/${name}.svg`));
const heartIcon = filled => fileIcon(`ytfocus-heart-${filled ? 'filled' : 'outline'}-symbolic`);
const iconProps = icon => (typeof icon === 'string' ? {icon_name: icon} : {gicon: icon});

function iconButton(icon, styleClass, tooltip, onClick) {
    const b = new St.Button({
        style_class: `ytf-icon-button ${styleClass}`,
        child: new St.Icon(iconProps(icon)),
        can_focus: true,
        accessible_name: tooltip,
        y_align: Clutter.ActorAlign.CENTER,
    });
    b.connect('clicked', () => onClick(b));
    return b;
}

function setCover(bin, file) {
    if (file && GLib.file_test(file, GLib.FileTest.EXISTS)) {
        bin.child = null;
        bin.style = `background-image: url("file://${file}");`;
    } else {
        bin.style = null;
        bin.child = new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'ytf-cover-placeholder'});
    }
}

function setChecked(actor, on) {
    if (on)
        actor.add_style_pseudo_class('checked');
    else
        actor.remove_style_pseudo_class('checked');
}

function shuffled(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

const FocusIndicator = GObject.registerClass(
class FocusIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Focus', false);
        this._ext = ext;
        this._state = null;
        this._stateAt = 0;
        this._library = {liked: [], playlists: [], recent: []};
        this._results = [];
        this._resultsError = '';
        this._view = {name: 'search'};
        this._seeking = false;
        this._searchSeq = 0;
        this._tickId = 0;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._panelIcon = new St.Icon({gicon: fileIcon('ytfocus-symbolic'), style_class: 'system-status-icon ytf-panel-icon'});
        this._panelLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER, style_class: 'ytf-panel-label', visible: false});
        this._panelLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._panelIcon);
        box.add_child(this._panelLabel);
        this.add_child(box);

        this.menu.box.add_style_class_name('ytf-menu');
        this._buildUi();

        this._proxy = new FocusProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, null, null,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START);
        this._signals = [
            this._proxy.connectSignal('StateChanged', (_p, _s, [json]) => this._onState(json)),
            this._proxy.connectSignal('LibraryChanged', (_p, _s, [json]) => this._onLibrary(json)),
        ];
        this._ownerId = this._proxy.connect('notify::g-name-owner', () => this._onOwner());
        this.connect('destroy', () => this._cleanup());
        this._onOwner();

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._renderList();
                this._startTick();
                if (this._view.name === 'search')
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        global.stage.set_key_focus(this._searchEntry);
                        return GLib.SOURCE_REMOVE;
                    });
            } else {
                this._stopTick();
            }
        });
    }

    // Middle click: play/pause. Scroll: volume.
    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_MIDDLE) {
            this._call('Toggle');
            return Clutter.EVENT_STOP;
        }
        if (event.type() === Clutter.EventType.SCROLL && this._state?.track) {
            const dir = event.get_scroll_direction();
            const delta = dir === Clutter.ScrollDirection.UP ? 5 : dir === Clutter.ScrollDirection.DOWN ? -5 : 0;
            if (delta) {
                this._call('SetVolume', Math.max(0, Math.min(100, (this._state.volume ?? 0) + delta)));
                return Clutter.EVENT_STOP;
            }
        }
        return super.vfunc_event(event);
    }

    // -----------------------------------------------------------------------
    // D-Bus
    // -----------------------------------------------------------------------

    get _online() {
        return !!this._proxy?.g_name_owner;
    }

    async _call(method, ...args) {
        if (!this._online)
            return null;
        try {
            return await this._proxy[`${method}Async`](...args);
        } catch (e) {
            console.warn(`yt-focus: ${method}: ${e.message}`);
            return null;
        }
    }

    async _onOwner() {
        if (!this._proxy)
            return;
        if (!this._online) {
            this._state = null;
            this._updateNowPlaying();
            return;
        }
        const [state] = (await this._call('GetState')) ?? [];
        if (state)
            this._onState(state);
        const [lib] = (await this._call('GetLibrary')) ?? [];
        if (lib)
            this._onLibrary(lib);
    }

    _onState(json) {
        try {
            this._state = JSON.parse(json);
            this._stateAt = GLib.get_monotonic_time();
        } catch (_) {
            return;
        }
        this._updateNowPlaying();
    }

    _onLibrary(json) {
        try {
            const lib = JSON.parse(json);
            this._library = {liked: lib.liked ?? [], playlists: lib.playlists ?? [], recent: lib.recent ?? []};
        } catch (_) {
            return;
        }
        if (this._view.name === 'playlist' && !this._library.playlists.some(p => p.id === this._view.id))
            this._view = {name: 'playlists'};
        if (this.menu.isOpen && this._view.name !== 'pick')
            this._renderList();
    }

    // Without a browser connection, playing something opens it in the browser.
    _openInBrowser(videoId) {
        const url = ID_RE.test(videoId || '') ? `https://www.youtube.com/watch?v=${videoId}` : 'https://www.youtube.com/';
        try {
            Gio.AppInfo.launch_default_for_uri(url, global.create_app_launch_context(0, -1));
        } catch (e) {
            console.warn(`yt-focus: open browser: ${e.message}`);
        }
        this.menu.close();
    }

    _play(tracks, index) {
        const ids = tracks.map(t => t.videoId).filter(id => ID_RE.test(id));
        if (!ids.length)
            return;
        if (this._online)
            this._call('Play', JSON.stringify(ids), index);
        else
            this._openInBrowser(ids[index] ?? ids[0]);
    }

    // -----------------------------------------------------------------------
    // Interface
    // -----------------------------------------------------------------------

    _buildUi() {
        const root = new St.BoxLayout({orientation: VERTICAL, style_class: 'ytf-root'});
        this.menu.box.add_child(root);

        // --- now playing --------------------------------------------------
        const now = new St.BoxLayout({style_class: 'ytf-now'});
        this._cover = new St.Bin({style_class: 'ytf-cover'});
        setCover(this._cover, '');
        now.add_child(this._cover);

        const meta = new St.BoxLayout({orientation: VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = label(T.nothing, 'ytf-title');
        this._artist = label(T.nothingSub, 'ytf-artist');
        meta.add_child(this._title);
        meta.add_child(this._artist);
        now.add_child(meta);

        this._likeBtn = iconButton(heartIcon(false), 'ytf-like', T.like, () => this._call('ToggleLikeCurrent'));
        now.add_child(this._likeBtn);
        root.add_child(now);

        // --- progress -----------------------------------------------------
        this._progress = new Slider(0);
        this._progress.add_style_class_name('ytf-progress');
        this._progress.accessible_name = T.position;
        this._progress.connect('drag-begin', () => (this._seeking = true));
        this._progress.connect('drag-end', () => {
            this._seeking = false;
            const len = this._state?.length ?? 0;
            if (len > 0)
                this._call('Seek', this._progress.value * len);
        });
        this._progress.connect('scroll-event', () => Clutter.EVENT_STOP);
        root.add_child(this._progress);

        const times = new St.BoxLayout({style_class: 'ytf-times'});
        this._posLabel = new St.Label({text: '0:00', x_expand: true});
        this._lenLabel = new St.Label({text: '0:00'});
        times.add_child(this._posLabel);
        times.add_child(this._lenLabel);
        root.add_child(times);

        // --- controls -----------------------------------------------------
        const controls = new St.BoxLayout({style_class: 'ytf-controls', x_align: Clutter.ActorAlign.CENTER});
        this._modeBtn = iconButton(MODE_ICON.video, 'ytf-toggle', T.mode.video, () => {
            const cur = MODES.indexOf(this._state?.videoMode ?? 'video');
            this._call('SetVideoMode', MODES[(cur + 1) % MODES.length]);
        });
        this._prevBtn = iconButton('media-skip-backward-symbolic', '', T.prev, () => this._call('Previous'));
        this._playBtn = iconButton('media-playback-start-symbolic', 'ytf-play', T.play, () => this._call('Toggle'));
        this._nextBtn = iconButton('media-skip-forward-symbolic', '', T.next, () => this._call('Next'));
        this._browserBtn = iconButton('web-browser-symbolic', '', T.browser, () => {
            if (this._online) {
                this._call('ShowBrowser');
                this.menu.close();
            } else {
                this._openInBrowser(null);
            }
        });
        for (const b of [this._modeBtn, this._prevBtn, this._playBtn, this._nextBtn, this._browserBtn])
            controls.add_child(b);
        root.add_child(controls);

        // --- volume -------------------------------------------------------
        const vol = new St.BoxLayout({style_class: 'ytf-volume'});
        this._volIcon = new St.Icon({icon_name: 'audio-volume-medium-symbolic', style_class: 'ytf-volume-icon'});
        this._volume = new Slider(0.7);
        this._volume.x_expand = true;
        this._volume.accessible_name = T.volume;
        this._volume.connect('drag-begin', () => (this._volDragging = true));
        this._volume.connect('drag-end', () => (this._volDragging = false));
        this._volume.connect('notify::value', () => {
            if (this._settingVolume)
                return;
            this._updateVolumeIcon(this._volume.value * 100);
            this._call('SetVolume', Math.round(this._volume.value * 100));
        });
        vol.add_child(this._volIcon);
        vol.add_child(this._volume);
        root.add_child(vol);

        root.add_child(new St.Widget({style_class: 'ytf-separator', x_expand: true}));

        // --- tabs ---------------------------------------------------------
        const tabs = new St.BoxLayout({style_class: 'ytf-tabs', x_expand: true});
        this._tabs = {};
        for (const [name, text, icon] of [
            ['search', T.search, 'system-search-symbolic'],
            ['liked', T.liked, heartIcon(true)],
            ['playlists', T.playlists, 'view-list-symbolic'],
            ['recent', T.recent, 'document-open-recent-symbolic'],
        ]) {
            const content = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style_class: 'ytf-tab-content'});
            content.add_child(new St.Icon({...iconProps(icon), style_class: 'ytf-tab-icon'}));
            content.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
            const b = new St.Button({style_class: 'ytf-tab', child: content, x_expand: true, can_focus: true, accessible_name: text});
            b.connect('clicked', () => this._setView({name}));
            tabs.add_child(b);
            this._tabs[name] = b;
        }
        root.add_child(tabs);

        // --- search -------------------------------------------------------
        this._searchEntry = new St.Entry({
            style_class: 'ytf-search',
            hint_text: T.searchHint,
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'ytf-search-icon'}),
        });
        this._searchEntry.clutter_text.connect('activate', () => this._doSearch());
        root.add_child(this._searchEntry);

        // --- list ---------------------------------------------------------
        this._listHeader = new St.BoxLayout({style_class: 'ytf-list-header', visible: false});
        root.add_child(this._listHeader);

        this._list = new St.BoxLayout({orientation: VERTICAL, style_class: 'ytf-list'});
        this._scroll = new St.ScrollView({
            style_class: 'ytf-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._list,
        });
        root.add_child(this._scroll);

        // --- footer -------------------------------------------------------
        const footer = new St.BoxLayout({style_class: 'ytf-footer'});
        this._statusLabel = label('', 'ytf-status', {x_expand: true});
        footer.add_child(this._statusLabel);
        this._focusBtn = iconButton('view-reveal-symbolic', 'ytf-small ytf-toggle', T.focusOn,
            () => this._call('SetFocus', !(this._state?.focus ?? true)));
        footer.add_child(this._focusBtn);
        root.add_child(footer);

        this._updateNowPlaying();
        this._setView({name: 'search'});
    }

    _updateVolumeIcon(v) {
        this._volIcon.icon_name = v <= 0 ? 'audio-volume-muted-symbolic'
            : v < 34 ? 'audio-volume-low-symbolic'
                : v < 67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
    }

    /** Position estimated between state updates (the tab reports ~1/s). */
    _position() {
        const s = this._state;
        if (!s?.track)
            return 0;
        let pos = s.position ?? 0;
        if (s.status === 'playing')
            pos += (GLib.get_monotonic_time() - this._stateAt) / 1e6;
        return s.length > 0 ? Math.min(pos, s.length) : pos;
    }

    _startTick() {
        if (this._tickId)
            return;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._updateTimes();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTick() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
    }

    _updateTimes() {
        const s = this._state;
        const len = s?.length ?? 0;
        const pos = this._position();
        if (!this._seeking)
            this._progress.value = len > 0 ? Math.min(1, pos / len) : 0;
        this._posLabel.text = s?.status === 'ad' ? T.adStatus : fmtTime(pos);
        this._lenLabel.text = len > 0 ? (s?.status === 'ad' ? `−${fmtTime(len - pos)}` : fmtTime(len)) : '0:00';
    }

    _updateNowPlaying() {
        const online = this._online;
        const s = online ? this._state : null;
        const t = s?.track;
        const ad = s?.status === 'ad';
        const playing = s?.status === 'playing' || ad;

        if (!online)
            this._statusLabel.text = T.offlineStatus;
        else if (ad)
            this._statusLabel.text = `🔇 ${T.adStatus}`;
        else
            this._statusLabel.text = T.connected;

        this._title.text = t?.title || (online ? T.nothing : T.offline);
        this._artist.text = ad ? T.ad : t ? t.artist || '' : online ? T.nothingSub : T.offlineSub;
        this._artist.style_class = ad ? 'ytf-artist ytf-ad' : 'ytf-artist';
        if (this._coverFile !== (t?.thumbFile ?? '')) {
            this._coverFile = t?.thumbFile ?? '';
            setCover(this._cover, this._coverFile);
        }

        this._playBtn.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playBtn.accessible_name = playing ? T.pause : T.play;
        for (const b of [this._playBtn, this._prevBtn, this._nextBtn, this._likeBtn, this._progress, this._volume])
            b.reactive = !!t;
        this._progress.reactive = !!t && !ad;
        this._modeBtn.reactive = online;
        this._focusBtn.reactive = online;

        setChecked(this._likeBtn, !!s?.liked);
        this._likeBtn.child.gicon = heartIcon(!!s?.liked);
        this._likeBtn.accessible_name = s?.liked ? T.unlike : T.like;

        const mode = MODES.includes(s?.videoMode) ? s.videoMode : 'video';
        this._modeBtn.child.icon_name = MODE_ICON[mode];
        this._modeBtn.accessible_name = T.mode[mode];
        setChecked(this._modeBtn, mode !== 'video');

        const focus = s?.focus ?? true;
        setChecked(this._focusBtn, online && focus);
        this._focusBtn.accessible_name = focus ? T.focusOn : T.focusOff;

        this._updateTimes();

        if (s && t && !this._volDragging) {
            this._settingVolume = true;
            this._volume.value = (s.volume ?? 0) / 100;
            this._settingVolume = false;
            this._updateVolumeIcon(s.volume ?? 0);
        }

        // Panel: icon dims when nothing plays; title shown if enabled.
        this._panelIcon.opacity = playing ? 255 : online ? 190 : 120;
        const showLabel = !!t && playing && this._ext.showTitle;
        this._panelLabel.visible = showLabel;
        if (showLabel)
            this._panelLabel.text = t.title;

        if (this._view.name !== 'pick' && this.menu.isOpen)
            this._markPlaying();
    }

    // -----------------------------------------------------------------------
    // Lists
    // -----------------------------------------------------------------------

    _setView(view) {
        this._view = view;
        const tab = view.name === 'playlist' || view.name === 'pick' ? (view.from ?? 'playlists') : view.name;
        for (const [name, b] of Object.entries(this._tabs))
            setChecked(b, name === tab);
        this._searchEntry.visible = view.name === 'search';
        this._renderList();
        if (view.name === 'search' && this.menu.isOpen)
            global.stage.set_key_focus(this._searchEntry);
    }

    async _doSearch() {
        const q = this._searchEntry.text.trim();
        if (!q)
            return;
        if (!this._online) {
            this._resultsError = T.needBrowser;
            this._results = [];
            this._renderList();
            return;
        }
        const seq = ++this._searchSeq;
        this._results = [];
        this._resultsError = '';
        this._placeholder(T.searching, 'system-search-symbolic');
        const res = await this._call('Search', q);
        if (seq !== this._searchSeq)
            return;
        try {
            this._results = res ? JSON.parse(res[0]) : [];
        } catch (_) {
            this._results = [];
        }
        this._resultsError = res ? '' : T.searchFail;
        if (this._view.name === 'search')
            this._renderList();
    }

    _placeholder(text, icon) {
        this._list.destroy_all_children();
        const box = new St.BoxLayout({orientation: VERTICAL, style_class: 'ytf-empty', x_expand: true});
        box.add_child(new St.Icon({...iconProps(icon), style_class: 'ytf-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({text, x_align: Clutter.ActorAlign.CENTER}));
        this._list.add_child(box);
    }

    _header(title, actions = [], back = null) {
        const h = this._listHeader;
        h.destroy_all_children();
        h.visible = true;
        if (back)
            h.add_child(iconButton('go-previous-symbolic', 'ytf-small', T.back, back));
        h.add_child(label(title, 'ytf-header-title', {x_expand: true}));
        for (const a of actions)
            h.add_child(a);
    }

    _renderList() {
        this._list.destroy_all_children();
        this._listHeader.visible = false;
        const v = this._view;
        const lib = this._library;

        if (v.name === 'search') {
            if (this._resultsError)
                this._placeholder(this._resultsError, 'network-error-symbolic');
            else if (!this._results.length)
                this._placeholder(T.typeEnter, 'audio-x-generic-symbolic');
            else
                this._trackRows(this._results);
        } else if (v.name === 'liked') {
            this._header(T.likedN(lib.liked.length), this._playActions(lib.liked));
            if (!lib.liked.length)
                this._placeholder(T.likeHint, heartIcon(false));
            else
                this._trackRows(lib.liked);
        } else if (v.name === 'recent') {
            if (!lib.recent.length)
                this._placeholder(T.emptyRecent, 'document-open-recent-symbolic');
            else
                this._trackRows(lib.recent);
        } else if (v.name === 'playlists') {
            this._renderPlaylists();
        } else if (v.name === 'playlist') {
            const pl = lib.playlists.find(p => p.id === v.id);
            if (!pl)
                return;
            this._header(pl.name, [
                ...this._playActions(pl.tracks),
                iconButton('user-trash-symbolic', 'ytf-small ytf-danger', T.del, () => {
                    this._call('DeletePlaylist', pl.id);
                    this._setView({name: 'playlists'});
                }),
            ], () => this._setView({name: 'playlists'}));
            if (!pl.tracks.length)
                this._placeholder(T.useAdd, 'list-add-symbolic');
            else
                this._trackRows(pl.tracks, pl.id);
        } else if (v.name === 'pick') {
            this._renderPicker(v.track, v.from);
        }
        this._markPlaying();
    }

    _playActions(tracks) {
        if (!tracks.length)
            return [];
        return [
            iconButton('media-playlist-shuffle-symbolic', 'ytf-small', T.shuffle, () => this._play(shuffled(tracks), 0)),
            iconButton('media-playback-start-symbolic', 'ytf-small ytf-accent', T.playAll, () => this._play(tracks, 0)),
        ];
    }

    _trackRows(tracks, playlistId = null) {
        tracks.forEach((t, i) => {
            const row = new St.BoxLayout({style_class: 'ytf-row', x_expand: true});
            row._videoId = t.videoId;

            const main = new St.BoxLayout({x_expand: true, style_class: 'ytf-row-content'});
            const cover = new St.Bin({style_class: 'ytf-row-cover'});
            setCover(cover, t.thumbFile);
            main.add_child(cover);
            const text = new St.BoxLayout({orientation: VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            text.add_child(label(t.title, 'ytf-row-title'));
            text.add_child(label([t.artist, t.duration ? fmtTime(t.duration) : ''].filter(Boolean).join(' · '), 'ytf-row-sub'));
            main.add_child(text);

            const btn = new St.Button({child: main, x_expand: true, can_focus: true, style_class: 'ytf-row-main',
                accessible_name: `${T.play} ${t.title}`});
            btn.connect('clicked', () => this._play(tracks, i));
            row.add_child(btn);

            const liked = this._library.liked.some(l => l.videoId === t.videoId);
            const like = iconButton(heartIcon(liked), 'ytf-small ytf-like', liked ? T.unlike : T.like, () => {
                if (liked)
                    this._call('Unlike', t.videoId);
                else
                    this._call('Like', JSON.stringify(t));
            });
            setChecked(like, liked);
            like.reactive = this._online;
            row.add_child(like);

            if (playlistId) {
                row.add_child(iconButton('list-remove-symbolic', 'ytf-small', T.remove,
                    () => this._call('RemoveFromPlaylist', playlistId, t.videoId)));
            } else {
                const add = iconButton('list-add-symbolic', 'ytf-small', T.addTo,
                    () => this._setView({name: 'pick', track: t, from: this._view.name}));
                add.reactive = this._online;
                row.add_child(add);
            }
            this._list.add_child(row);
        });
    }

    _markPlaying() {
        const id = this._online ? this._state?.track?.videoId : null;
        for (const row of this._list.get_children()) {
            if (row._videoId !== undefined)
                setChecked(row, row._videoId === id);
        }
    }

    _newPlaylistEntry(onCreated) {
        const entry = new St.Entry({
            style_class: 'ytf-search',
            hint_text: T.newPlaylist,
            can_focus: true,
            x_expand: true,
            reactive: this._online,
            primary_icon: new St.Icon({icon_name: 'list-add-symbolic', style_class: 'ytf-search-icon'}),
        });
        entry.clutter_text.connect('activate', async () => {
            const name = entry.text.trim();
            if (!name)
                return;
            const res = await this._call('CreatePlaylist', name);
            entry.text = '';
            if (res)
                onCreated?.(res[0]);
        });
        return entry;
    }

    _renderPlaylists() {
        const lib = this._library;
        this._list.add_child(this._newPlaylistEntry());
        if (!lib.playlists.length) {
            this._list.add_child(new St.Label({text: T.firstPlaylist, style_class: 'ytf-hint', x_align: Clutter.ActorAlign.CENTER}));
            return;
        }
        for (const pl of lib.playlists) {
            const content = new St.BoxLayout({x_expand: true, style_class: 'ytf-row-content'});
            const cover = new St.Bin({style_class: 'ytf-row-cover'});
            setCover(cover, pl.tracks[0]?.thumbFile);
            content.add_child(cover);
            const text = new St.BoxLayout({orientation: VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            text.add_child(label(pl.name, 'ytf-row-title'));
            text.add_child(label(T.songs(pl.tracks.length), 'ytf-row-sub'));
            content.add_child(text);
            content.add_child(new St.Icon({icon_name: 'go-next-symbolic', style_class: 'ytf-chevron'}));
            const b = new St.Button({child: content, x_expand: true, can_focus: true, style_class: 'ytf-row ytf-row-main'});
            b.connect('clicked', () => this._setView({name: 'playlist', id: pl.id}));
            this._list.add_child(b);
        }
    }

    _renderPicker(track, from) {
        const back = () => this._setView({name: from});
        this._header(T.add(track.title), [], back);
        const add = id => {
            this._call('AddToPlaylist', id, JSON.stringify(track));
            back();
            this._statusLabel.text = T.added(track.title);
        };
        this._list.add_child(this._newPlaylistEntry(add));
        for (const pl of this._library.playlists) {
            const has = pl.tracks.some(t => t.videoId === track.videoId);
            const content = new St.BoxLayout({x_expand: true, style_class: 'ytf-row-content'});
            content.add_child(new St.Icon({icon_name: has ? 'object-select-symbolic' : 'view-list-symbolic', style_class: 'ytf-pick-icon'}));
            content.add_child(label(pl.name, 'ytf-row-title', {x_expand: true}));
            const b = new St.Button({child: content, x_expand: true, can_focus: true, reactive: !has,
                style_class: 'ytf-row ytf-row-main ytf-pick-row'});
            b.connect('clicked', () => add(pl.id));
            this._list.add_child(b);
        }
    }

    _cleanup() {
        this._stopTick();
        if (!this._proxy)
            return;
        for (const id of this._signals)
            this._proxy.disconnectSignal(id);
        this._proxy.disconnect(this._ownerId);
        this._proxy = null;
    }
});

export default class FocusPanelExtension extends Extension {
    enable() {
        // Show the song title next to the icon while playing.
        this.showTitle = false;
        ICON_DIR = `${this.path}/icons`;
        this._indicator = new FocusIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
