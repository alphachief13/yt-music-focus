// Focus — YouTube search without the browser (used by the local player).
// Reads ytInitialData from youtube.com/results, like src/desktop.js does in
// the browser. parseTitle mirrors src/shared.js: keep both in sync.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const ID_RE = /^[\w-]{11}$/;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const http = new Soup.Session({timeout: 15, user_agent: UA});

// --- parseTitle (src/shared.js) -------------------------------------------
const JUNK =
    /\s*[([{【][^)\]}】]*?\b(official|video|audio|lyrics?|letra|legendado|tradu[çc][ãa]o|visuali[sz]er|clipe?|hd|hq|4k|remaster(ed)?|m\/?v|music)\b[^)\]}】]*[)\]}】]/gi;

export function parseTitle(raw = '', channel = '') {
    let title = String(raw).replace(JUNK, '').replace(/\s*[|｜/]{1,2}\s.*$/, '').trim();
    let artist = String(channel)
        .replace(/\s*-\s*Topic$/i, '')
        .replace(/VEVO$/i, '')
        .replace(/\s*(official)?$/i, '')
        .trim();
    const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) {
        artist = m[1].trim();
        title = m[2].trim();
    }
    title = title.replace(/^["“'‘](.+)["”'’]$/, '$1').replace(/\s+/g, ' ').trim() || String(raw).trim();
    return {title, artist};
}

// --- ytInitialData ----------------------------------------------------------
function textOf(t) {
    if (!t)
        return '';
    if (typeof t === 'string')
        return t;
    if (t.simpleText)
        return t.simpleText;
    if (t.content)
        return t.content;
    if (Array.isArray(t.runs))
        return t.runs.map(r => r.text).join('');
    return '';
}

function parseDuration(s) {
    if (!/^\d+(:\d\d)+$/.test(s || ''))
        return 0;
    return s.split(':').reduce((acc, n) => acc * 60 + Number(n), 0);
}

const SKIP = new Set(['reelShelfRenderer', 'shelfRenderer', 'horizontalCardListRenderer', 'gridShelfViewModel',
    'shortsLockupViewModel', 'secondarySearchContainerRenderer']);

export function parseSearch(html, limit = 20) {
    const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s) ||
        html.match(/window\["ytInitialData"\]\s*=\s*(\{.+?\});/s);
    if (!m)
        return [];
    let data;
    try {
        data = JSON.parse(m[1]);
    } catch (_) {
        return [];
    }
    const out = [];
    const seen = new Set();
    const add = (id, rawTitle, channel, durText) => {
        if (!ID_RE.test(id || '') || seen.has(id))
            return;
        const duration = parseDuration(durText);
        if (!duration)
            return; // live streams, premieres
        seen.add(id);
        const {title, artist} = parseTitle(rawTitle, channel);
        out.push({videoId: id, title, artist, duration});
    };
    const walk = node => {
        if (out.length >= limit || !node || typeof node !== 'object')
            return;
        if (Array.isArray(node)) {
            for (const n of node)
                walk(n);
            return;
        }
        for (const [k, v] of Object.entries(node)) {
            if (out.length >= limit)
                return;
            if (SKIP.has(k))
                continue;
            if (k === 'videoRenderer' && v?.videoId) {
                add(v.videoId, textOf(v.title), textOf(v.ownerText || v.longBylineText), textOf(v.lengthText));
            } else if (k === 'lockupViewModel' && v?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
                const md = v.metadata?.lockupMetadataViewModel;
                const channel = textOf(md?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text);
                const badge = JSON.stringify(v.contentImage || {}).match(/"text":"(\d+(?::\d\d)+)"/);
                add(v.contentId, textOf(md?.title), channel, badge?.[1]);
            } else if (v && typeof v === 'object') {
                walk(v);
            }
        }
    };
    walk(data);
    return out;
}

export async function search(query) {
    const q = String(query || '').trim().slice(0, 200);
    if (!q)
        return [];
    const msg = Soup.Message.new('GET', `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=pt&gl=BR`);
    msg.request_headers.append('Accept-Language', 'pt-BR,pt;q=0.9,en;q=0.8');
    // Skips the EU consent interstitial; harmless elsewhere.
    msg.request_headers.append('Cookie', 'SOCS=CAI; CONSENT=YES+');
    const bytes = await http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    if (msg.get_status() !== Soup.Status.OK)
        throw new Error(`HTTP ${msg.get_status()}`);
    return parseSearch(new TextDecoder().decode(bytes.toArray()));
}
