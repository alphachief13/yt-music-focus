#!/usr/bin/env -S gjs -m
// Focus — native messaging host for the GNOME panel.
//
// Chrome starts this process when the Focus extension connects (only if the
// user enabled the desktop integration). It relays between:
//   stdin/stdout  — Chrome native messaging (uint32 length + JSON)
//   D-Bus         — io.github.alphachief13.YtFocus, consumed by the panel
// and caches cover thumbnails under ~/.cache/yt-focus/thumbs.
//
// stdout is the protocol channel: never print to it. Logs go to stderr.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLibUnix from 'gi://GLibUnix';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {IFACE_XML, BUS_NAME, OBJECT_PATH} from './iface.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
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
// Covers
// ---------------------------------------------------------------------------
const THUMB_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'yt-focus', 'thumbs']);
GLib.mkdir_with_parents(THUMB_DIR, 0o700);
const http = new Soup.Session({timeout: 15});
const pendingThumbs = new Map();

const thumbPath = id => GLib.build_filenamev([THUMB_DIR, `${id}.jpg`]);

function ensureThumb(id) {
    if (!ID_RE.test(id || ''))
        return Promise.resolve('');
    const path = thumbPath(id);
    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        return Promise.resolve(path);
    if (pendingThumbs.has(id))
        return pendingThumbs.get(id);
    const p = (async () => {
        try {
            const msg = Soup.Message.new('GET', `https://i.ytimg.com/vi/${id}/mqdefault.jpg`);
            const bytes = await http.send_and_read_async(msg, GLib.PRIORITY_LOW, null);
            if (msg.get_status() !== Soup.Status.OK || bytes.get_size() === 0)
                return '';
            await Gio.File.new_for_path(path).replace_contents_bytes_async(
                bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            return path;
        } catch (e) {
            log(`cover ${id}: ${e.message}`);
            return '';
        } finally {
            pendingThumbs.delete(id);
        }
    })();
    pendingThumbs.set(id, p);
    return p;
}

/** Path if cached; otherwise starts the download and calls `later` when done. */
function thumbNow(id, later) {
    if (!ID_RE.test(id || ''))
        return '';
    const path = thumbPath(id);
    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        return path;
    ensureThumb(id).then(p => p && later());
    return '';
}

// ---------------------------------------------------------------------------
// State relayed to the panel
// ---------------------------------------------------------------------------
let state = null;     // last tab state from Chrome
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
        return JSON.stringify({connected: true, track: null, status: 'idle', videoMode: s?.videoMode ?? 'video', focus: s?.focus ?? true});
    return JSON.stringify({
        connected: true,
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
    case 'state':
        state = m.state && typeof m.state === 'object' ? m.state : null;
        emitState();
        break;
    case 'library':
        if (m.library && typeof m.library === 'object')
            library = m.library;
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
};

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const loop = new GLib.MainLoop(null, false);
let ownerId = 0;

function quit() {
    if (ownerId)
        Gio.bus_unown_name(ownerId);
    ownerId = 0;
    loop.quit();
}

dbus = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, impl);
ownerId = Gio.bus_own_name(
    Gio.BusType.SESSION, BUS_NAME,
    // Several browsers/profiles: the most recent connection takes the panel.
    Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
    conn => dbus.export(conn, OBJECT_PATH),
    () => emitState(),
    () => log('lost the D-Bus name (another browser took over)'));

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
