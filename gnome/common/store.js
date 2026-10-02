// Focus — files shared by the native host and the local player (daemon).
//
//   ~/.local/share/yt-focus/library.json  mirror of the browser library (written by the host)
//   ~/.local/share/yt-focus/pending.json  edits made without the browser (applied on reconnect)
//   ~/.local/share/yt-focus/session.json  last song / position / queue, for the hand-off
//
// The library shape is the one the panel uses:
//   {liked: [track], playlists: [{id, name, tracks: [track]}], recent: [track], settings: {videoMode, focus}}
//   track = {videoId, title, artist, duration}
import GLib from 'gi://GLib';

export const BASE = GLib.build_filenamev([GLib.get_user_data_dir(), 'yt-focus']);
export const ID_RE = /^[\w-]{11}$/;
GLib.mkdir_with_parents(BASE, 0o700);

const enc = new TextEncoder();
const dec = new TextDecoder();
const path = name => GLib.build_filenamev([BASE, name]);

export function readJson(name, fallback) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path(name));
        if (ok)
            return JSON.parse(dec.decode(bytes));
    } catch (_) { /* missing or corrupt: use the fallback */ }
    return fallback;
}

export function writeJson(name, data) {
    try {
        // file_set_contents writes to a temp file and renames: never half-written.
        GLib.file_set_contents(path(name), enc.encode(JSON.stringify(data)));
    } catch (e) {
        printerr(`yt-focus: write ${name}: ${e.message}`);
    }
}

export function removeFile(name) {
    try {
        GLib.unlink(path(name));
    } catch (_) { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

export function cleanTrack(t) {
    if (!t || !ID_RE.test(t.videoId || ''))
        return null;
    return {
        videoId: t.videoId,
        title: str(t.title) || t.videoId,
        artist: str(t.artist),
        duration: Number.isFinite(t.duration) && t.duration > 0 ? Math.round(t.duration) : 0,
    };
}

export function emptyLibrary() {
    return {liked: [], playlists: [], recent: [], settings: {videoMode: 'video', focus: true}};
}

export function normalizeLibrary(lib) {
    const out = emptyLibrary();
    if (!lib || typeof lib !== 'object')
        return out;
    const tracks = a => (Array.isArray(a) ? a.map(cleanTrack).filter(Boolean) : []);
    out.liked = tracks(lib.liked);
    out.recent = tracks(lib.recent).slice(0, 50);
    out.playlists = (Array.isArray(lib.playlists) ? lib.playlists : [])
        .filter(p => p && typeof p.id === 'string' && typeof p.name === 'string')
        .map(p => ({id: p.id.slice(0, 40), name: p.name.slice(0, 80), tracks: tracks(p.tracks)}));
    if (lib.settings && typeof lib.settings === 'object') {
        if (['video', 'cover', 'dark'].includes(lib.settings.videoMode))
            out.settings.videoMode = lib.settings.videoMode;
        if (typeof lib.settings.focus === 'boolean')
            out.settings.focus = lib.settings.focus;
    }
    return out;
}

/** Applies one edit (same ops the browser side understands). Returns a new library. */
export function applyOp(lib, op) {
    const l = JSON.parse(JSON.stringify(lib));
    const track = cleanTrack(op?.track);
    switch (op?.op) {
    case 'like':
        if (track)
            l.liked = [track, ...l.liked.filter(t => t.videoId !== track.videoId)];
        break;
    case 'unlike':
        l.liked = l.liked.filter(t => t.videoId !== op.id);
        break;
    case 'createPlaylist':
        if (typeof op.id === 'string' && str(op.name) && !l.playlists.some(p => p.id === op.id))
            l.playlists.push({id: op.id, name: str(op.name, 80), tracks: []});
        break;
    case 'deletePlaylist':
        l.playlists = l.playlists.filter(p => p.id !== op.id);
        break;
    case 'addToPlaylist':
        if (track) {
            for (const p of l.playlists) {
                if (p.id === op.id && !p.tracks.some(t => t.videoId === track.videoId))
                    p.tracks.push(track);
            }
        }
        break;
    case 'removeFromPlaylist':
        for (const p of l.playlists) {
            if (p.id === op.id)
                p.tracks = p.tracks.filter(t => t.videoId !== op.videoId);
        }
        break;
    case 'played':
        if (track)
            l.recent = [track, ...l.recent.filter(t => t.videoId !== track.videoId)].slice(0, 50);
        break;
    case 'setting':
        if (op.key === 'videoMode' && ['video', 'cover', 'dark'].includes(op.value))
            l.settings.videoMode = op.value;
        if (op.key === 'focus' && typeof op.value === 'boolean')
            l.settings.focus = op.value;
        break;
    }
    return l;
}

/** The library as the local player sees it: browser mirror + pending edits. */
export function libraryView() {
    let lib = normalizeLibrary(readJson('library.json', null));
    for (const op of pendingOps())
        lib = applyOp(lib, op);
    return lib;
}

export function pendingOps() {
    const ops = readJson('pending.json', []);
    return Array.isArray(ops) ? ops : [];
}

export function addPending(op) {
    const ops = pendingOps();
    ops.push(op);
    writeJson('pending.json', ops.slice(-1000));
}

/** Reads and clears the pending edits (the host sends them to the browser). */
export function takePending() {
    const ops = pendingOps();
    removeFile('pending.json');
    return ops;
}
