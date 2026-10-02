#!/usr/bin/env -S gjs -m
// Focus — native messaging host for the GNOME panel.
//
// Chrome starts this process when the Focus extension connects (only if the
// user enabled the desktop integration). It relays between:
//   stdin/stdout  — Chrome native messaging (uint32 length + JSON)
//   D-Bus         — io.github.alphachief13.YtFocus, consumed by the panel
// It also keeps ~/.local/share/yt-focus/{library,session}.json up to date, so
// the local player (daemon/main.js) can carry on when the browser closes:
//   - browser exits while a song plays -> starts the local player (--resume)
//   - local player playing when the browser opens -> waits; takes the panel
//     back (D-Bus REPLACE) only when a Focus tab starts playing
//   - edits made without the browser (pending.json) go to the browser here
//
// stdout is the protocol channel: never print to it. Logs go to stderr.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLibUnix from 'gi://GLibUnix';
import System from 'system';

import {IFACE_XML, BUS_NAME, OBJECT_PATH} from '../common/iface.js';
import {readJson, writeJson, takePending, normalizeLibrary} from '../common/store.js';
import {ensureThumb, thumbNow} from '../common/thumbs.js';

const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const PLAYER = GLib.canonicalize_filename(GLib.build_filenamev([HERE, '..', 'daemon', 'main.js']), null);

Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

const log = (...a) => printerr(`focus-host: ${a.join(' ')}`);
const ID_RE = /^[\w-]{11}$/;
const MAX_IN = 8 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Native messaging (Chrome <-> host)
// ---------------------------------------------------------------------------
// GNOME 48+ ships GLib ≥ 2.84, where the Unix bits live in GioUnix/GLibUnix.
const UnixIn = GioUnix.InputStream;
const UnixOut = GioUnix.OutputStream;
const onSignal = (sig, fn) => GLibUnix.signal_add_full(GLib.PRIORITY_DEFAULT, sig, fn);

const stdin = new UnixIn({fd: 0, close_fd: false});
const stdout = new UnixOut({fd: 1, close_fd: false});
const enc = new TextEncoder();
const dec = new TextDecoder();

function send(msg) {
    const body = enc.encode(JSON.stringify(msg));
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, body.length, true);
    try {
        stdout.write_all(head, null);
        stdout.write_all(body, null);
        stdout.flush(null);
    } catch (e) {
        log(`write failed: ${e.message}`);
        quit();
    }
}

async function readExactly(n) {
    const chunks = [];
    let got = 0;
    while (got < n) {
        const bytes = await stdin.read_bytes_async(n - got, GLib.PRIORITY_DEFAULT, null);
        const size = bytes.get_size();
        if (size === 0)
            return null; // Chrome closed the port
        chunks.push(bytes.toArray());
        got += size;
    }
    const out = new Uint8Array(n);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.length;
    }
    return out;
}

async function readLoop() {
    for (;;) {
        const head = await readExactly(4);
        if (!head)
            return quit();
        const len = new DataView(head.buffer).getUint32(0, true);
        if (len > MAX_IN) {
            log(`message too large (${len})`);
            return quit();
        }
        const body = await readExactly(len);
        if (!body)
            return quit();
        try {
            onChrome(JSON.parse(dec.decode(body)));
        } catch (e) {
            log(`bad message: ${e.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// State relayed to the panel
// ---------------------------------------------------------------------------
let state = null;     // last tab state from Chrome
let stateAt = 0;      // when it arrived (to estimate the position at exit)
let bye = false;      // the browser turned the bridge off on purpose
let library = {liked: [], playlists: [], recent: []};
let searchSeq = 0;
const searches = new Map();

const debounce = (fn, ms) => {
    let id = 0;
    return () => {
        if (id)
            return;
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            id = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    };
};

function stateJson() {
    const s = state;
    if (!s?.id)
        return JSON.stringify({connected: true, backend: 'browser', track: null, status: 'idle', videoMode: s?.videoMode ?? 'video', focus: s?.focus ?? true});
    return JSON.stringify({
        connected: true,
        backend: 'browser',
        track: {
            videoId: s.id,
            title: String(s.title || ''),
            artist: String(s.artist || ''),
            thumbFile: thumbNow(s.id, emitStateSoon),
        },
        status: s.ad ? 'ad' : s.playing ? 'playing' : 'paused',
        position: Number(s.position) || 0,
        length: Number(s.duration) || 0,
        volume: s.muted ? 0 : Number(s.volume) || 0,
        muted: !!s.muted,
        liked: !!s.liked,
        videoMode: s.videoMode || 'video',
        focus: s.focus !== false,
    });
}

const withThumb = t => ({...t, thumbFile: thumbNow(t.videoId, emitLibrarySoon)});

function libraryJson() {
    return JSON.stringify({
        liked: (library.liked || []).map(withThumb),
        playlists: (library.playlists || []).map(p => ({...p, tracks: (p.tracks || []).map(withThumb)})),
        recent: (library.recent || []).map(withThumb),
    });
}

let dbus = null;
const emit = (name, json) => dbus?.emit_signal(name, new GLib.Variant('(s)', [json]));
const emitState = () => emit('StateChanged', stateJson());
const emitLibrary = () => emit('LibraryChanged', libraryJson());
const emitStateSoon = debounce(emitState, 150);
const emitLibrarySoon = debounce(emitLibrary, 400);

function onChrome(m) {
    switch (m?.type) {
    case 'hello':
        log(`connected (extension ${m.version})`);
        break;
    case 'bye':
        bye = true;
        break;
    case 'state':
        state = m.state && typeof m.state === 'object' ? m.state : null;
        stateAt = GLib.get_monotonic_time();
        if (state?.id && state.playing && !owned)
            ownName(); // a Focus tab plays: take the panel back from the local player
        saveSessionSoon();
        saveMirror();
        emitState();
        break;
    case 'library':
        if (m.library && typeof m.library === 'object')
            library = m.library;
        saveMirror();
        emitLibrary();
        break;
    case 'results': {
        const done = searches.get(m.seq);
        if (done)
            done(m);
        break;
    }
    }
}

// ---------------------------------------------------------------------------
// Files for the local player
// ---------------------------------------------------------------------------
function estimatedPosition() {
    let pos = Number(state?.position) || 0;
    if (state?.playing && !state.ad)
        pos += (GLib.get_monotonic_time() - stateAt) / 1e6;
    const d = Number(state?.duration) || 0;
    return d > 0 ? Math.min(pos, d) : pos;
}

function saveSession() {
    if (!owned || !state?.id)
        return;
    const prev = readJson('session.json', {}) || {};
    writeJson('session.json', {
        videoId: state.id,
        title: String(state.title || ''),
        artist: String(state.artist || ''),
        duration: Number(state.duration) || 0,
        position: Math.floor(estimatedPosition()),
        playing: !!state.playing,
        queue: Array.isArray(state.queue) ? state.queue : [],
        volume: state.muted ? 0 : Number(state.volume) || prev.volume || 70,
        at: Date.now(),
        by: 'browser',
    });
}
const saveSessionSoon = debounce(saveSession, 2000);

function saveMirror() {
    const lib = normalizeLibrary({
        ...library,
        settings: {videoMode: state?.videoMode, focus: state?.focus},
    });
    if (!state) {
        // keep the last known settings
        const old = readJson('library.json', null);
        if (old?.settings)
            lib.settings = normalizeLibrary(old).settings;
    }
    writeJson('library.json', lib);
}

/** Edits made in the panel without the browser: replay them in the browser. */
function flushPending() {
    const ops = takePending();
    for (const op of ops) {
        if (op.op === 'setting' && op.key === 'videoMode')
            cmd('videoMode', {mode: op.value});
        else if (op.op === 'setting' && op.key === 'focus')
            cmd('focus', {on: !!op.value});
        else if (op.op)
            cmd('lib', op);
    }
    if (ops.length)
        log(`synced ${ops.length} edit(s) made without the browser`);
}

/** The browser is going away mid-song: let the local player carry on. */
function handOff() {
    if (bye || !owned || !state?.id || !state.playing)
        return;
    if (!GLib.file_test(PLAYER, GLib.FileTest.EXISTS))
        return;
    saveSession();
    try {
        // setsid: the player must outlive this process (Chrome kills its hosts).
        Gio.Subprocess.new(['setsid', '-f', 'gjs', '-m', PLAYER, '--resume'],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        log('browser closed: local player takes over');
    } catch (e) {
        log(`could not start the local player: ${e.message}`);
    }
}

const cmd = (name, extra = {}) => send({type: 'cmd', cmd: name, ...extra});
const libOp = (op, extra = {}) => cmd('lib', {op, ...extra});

function parseTrack(json) {
    const t = JSON.parse(json);
    if (!ID_RE.test(t?.videoId || ''))
        throw new Error('invalid track');
    return {videoId: t.videoId, title: String(t.title || ''), artist: String(t.artist || ''), duration: Number(t.duration) || 0};
}

function search(query) {
    const seq = ++searchSeq;
    return new Promise((resolve, reject) => {
        const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_TIMEOUT_MS, () => {
            searches.delete(seq);
            reject(new Error('timeout'));
            return GLib.SOURCE_REMOVE;
        });
        searches.set(seq, m => {
            GLib.source_remove(timer);
            searches.delete(seq);
            if (m.error)
                reject(new Error(String(m.error)));
            else
                resolve(Array.isArray(m.items) ? m.items : []);
        });
        send({type: 'search', seq, q: String(query).slice(0, 200)});
    });
}

const fail = (inv, e) => inv.return_error_literal(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED, String(e?.message || e));

const impl = {
    GetState: () => stateJson(),
    GetLibrary: () => libraryJson(),
    SearchAsync([query], inv) {
        search(query)
            .then(items => Promise.all(items.map(t => ensureThumb(t.videoId).then(f => ({...t, thumbFile: f})))))
            .then(items => inv.return_value(new GLib.Variant('(s)', [JSON.stringify(items)])))
            .catch(e => fail(inv, e));
    },
    Play(idsJson, index) {
        const ids = JSON.parse(idsJson).filter(id => ID_RE.test(id)).slice(0, 500);
        if (ids.length)
            cmd('play', {ids, index: Math.max(0, Math.min(ids.length - 1, index))});
    },
    Toggle: () => cmd('toggle'),
    Next: () => cmd('next'),
    Previous: () => cmd('prev'),
    Seek: t => cmd('seek', {t: Math.max(0, t)}),
    SetVolume: v => cmd('volume', {v: Math.max(0, Math.min(100, v))}),
    ToggleLikeCurrent: () => cmd('likeCurrent'),
    Like: json => libOp('like', {track: parseTrack(json)}),
    Unlike: id => ID_RE.test(id) && libOp('unlike', {id}),
    CreatePlaylist(name) {
        const id = `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        libOp('createPlaylist', {id, name: String(name).slice(0, 80)});
        return id;
    },
    DeletePlaylist: id => libOp('deletePlaylist', {id}),
    AddToPlaylist: (id, json) => libOp('addToPlaylist', {id, track: parseTrack(json)}),
    RemoveFromPlaylist: (id, videoId) => libOp('removeFromPlaylist', {id, videoId}),
    SetVideoMode: mode => ['video', 'cover', 'dark'].includes(mode) && cmd('videoMode', {mode}),
    SetFocus: on => cmd('focus', {on}),
    ShowBrowser: () => cmd('showBrowser'),
    ShowWindow: () => cmd('showBrowser'),
    Quit: () => {},
};

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const loop = new GLib.MainLoop(null, false);
let ownerId = 0;
let owned = false;
let quitting = false;

function quit() {
    if (quitting)
        return;
    quitting = true;
    handOff();
    if (ownerId)
        Gio.bus_unown_name(ownerId);
    ownerId = 0;
    loop.quit();
}

dbus = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, impl);

function ownName() {
    if (ownerId)
        return;
    ownerId = Gio.bus_own_name(
        Gio.BusType.SESSION, BUS_NAME,
        // REPLACE: takes over from the local player or another browser profile.
        Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
        conn => dbus.export(conn, OBJECT_PATH),
        () => {
            owned = true;
            emitState();
            emitLibrary();
            // The local player saves its last edits as it exits.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                flushPending();
                return GLib.SOURCE_REMOVE;
            });
        },
        () => {
            if (owned)
                log('lost the D-Bus name (another browser took over)');
            owned = false;
        });
}

// If the local player is already playing, don't cut it off just because the
// browser opened: wait until a Focus tab actually plays (see onChrome).
function nameHasOwner() {
    try {
        const [has] = Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'NameHasOwner', new GLib.Variant('(s)', [BUS_NAME]),
            new GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, 2000, null).deepUnpack();
        return has;
    } catch (_) {
        return false;
    }
}

if (nameHasOwner())
    log('local player active: waiting for a Focus tab to play');
else
    ownName();

onSignal(15, () => {
    quit();
    return GLib.SOURCE_REMOVE;
});

readLoop().catch(e => {
    log(`read loop: ${e.message}`);
    quit();
});
loop.run();
dbus.unexport();
System.exit(0);
