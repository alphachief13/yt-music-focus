// Focus — cover thumbnails cached under ~/.cache/yt-focus/thumbs, so the
// GNOME panel can show them as local files (St can't load https URLs).
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const ID_RE = /^[\w-]{11}$/;
const THUMB_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'yt-focus', 'thumbs']);
GLib.mkdir_with_parents(THUMB_DIR, 0o700);
const http = new Soup.Session({timeout: 15});
const pending = new Map();

export const thumbPath = id => GLib.build_filenamev([THUMB_DIR, `${id}.jpg`]);

/** Downloads the cover once; resolves to the local path, or '' on failure. */
export function ensureThumb(id) {
    if (!ID_RE.test(id || ''))
        return Promise.resolve('');
    const path = thumbPath(id);
    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        return Promise.resolve(path);
    if (pending.has(id))
        return pending.get(id);
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
            printerr(`yt-focus: cover ${id}: ${e.message}`);
            return '';
        } finally {
            pending.delete(id);
        }
    })();
    pending.set(id, p);
    return p;
}

/** Path if already cached; otherwise starts the download and calls `later` when done. */
export function thumbNow(id, later) {
    if (!ID_RE.test(id || ''))
        return '';
    const path = thumbPath(id);
    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        return path;
    ensureThumb(id).then(p => p && later?.());
    return '';
}
