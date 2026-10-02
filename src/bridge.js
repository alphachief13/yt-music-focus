/**
 * Focus — MAIN-world bridge.
 *
 * Content scripts live in an isolated world and cannot call YouTube's player
 * API (`#movie_player.playVideo()`, `getVideoData()`, ...). This tiny script
 * runs in the page's own world and relays commands/state via postMessage.
 *
 * Playback stays 100% YouTube's: we only call the public methods its own
 * controls use.
 */
(() => {
  "use strict";
  const TAG = "fx-bridge";
  const ID_RE = /^[\w-]{11}$/;
  const QUALITY = ["tiny", "small", "medium", "large", "hd720", "hd1080", "hd1440", "hd2160", "highres"];
  let lowered = false;
  let savedQuality = null;

  const player = () => document.getElementById("movie_player");
  const post = (type, data) =>
    window.postMessage({ [TAG]: "out", type, data }, location.origin);

  function readState() {
    const p = player();
    if (!p || typeof p.getVideoData !== "function") return null;
    let d = {};
    try { d = p.getVideoData() || {}; } catch (_) { /* player not ready */ }
    let playlist = [];
    try { playlist = p.getPlaylist?.() || []; } catch (_) { /* ignore */ }
    return {
      id: d.video_id || null,
      title: d.title || "",
      author: d.author || "",
      duration: Number(p.getDuration?.()) || 0,
      volume: Number(p.getVolume?.() ?? 100),
      muted: !!p.isMuted?.(),
      playlist: playlist.length > 0,
    };
  }

  // One pending fallback at a time: a newer navigation cancels the older one.
  let fallback = 0;
  function ytNavigate(url, endpoint, pageType, rootVe, arrived) {
    clearTimeout(fallback);
    // If YouTube ignores the SPA event, do a real navigation.
    fallback = setTimeout(() => {
      if (!arrived()) location.assign(url);
    }, 2500);
    const app = document.querySelector("ytd-app");
    if (!app) {
      clearTimeout(fallback);
      return location.assign(url);
    }
    app.dispatchEvent(
      new CustomEvent("yt-navigate", {
        bubbles: true,
        composed: true,
        detail: {
          endpoint: {
            commandMetadata: { webCommandMetadata: { url, webPageType: pageType, rootVe } },
            ...endpoint,
          },
        },
      })
    );
  }

  const commands = {
    toggle() {
      const p = player();
      if (!p) return;
      p.getPlayerState?.() === 1 ? p.pauseVideo() : p.playVideo();
    },
    seek({ t }) {
      const n = Number(t);
      if (Number.isFinite(n)) player()?.seekTo(Math.max(0, n), true);
    },
    volume({ v }) {
      const p = player();
      const n = Math.round(Number(v));
      if (!p || !Number.isFinite(n)) return;
      p.setVolume(Math.min(100, Math.max(0, n)));
      if (n > 0 && p.isMuted()) p.unMute();
    },
    mute({ m }) {
      const p = player();
      if (p) m ? p.mute() : p.unMute();
    },
    next() { player()?.nextVideo?.(); },
    prev() { player()?.previousVideo?.(); },
    navigate({ id }) {
      if (!ID_RE.test(String(id))) return;
      const url = `/watch?v=${id}`;
      ytNavigate(url, { watchEndpoint: { videoId: id } }, "WEB_PAGE_TYPE_WATCH", 3832,
        () => new URLSearchParams(location.search).get("v") === id);
    },
    search({ q }) {
      const query = String(q || "").trim().slice(0, 200);
      if (!query) return;
      const url = `/results?search_query=${encodeURIComponent(query)}`;
      ytNavigate(url, { searchEndpoint: { query } }, "WEB_PAGE_TYPE_SEARCH", 4724,
        () => location.pathname === "/results");
    },
    home() {
      ytNavigate("/", { browseEndpoint: { browseId: "FEwhat_to_watch" } }, "WEB_PAGE_TYPE_BROWSE", 3854,
        () => location.pathname === "/");
    },
    resize() { window.dispatchEvent(new Event("resize")); },
    // Video off (cover / dark): stream the smallest rendition, the picture
    // isn't shown anyway. Restores the quality YouTube had picked before.
    lowq({ on }) {
      const p = player();
      if (!p || typeof p.setPlaybackQualityRange !== "function") return;
      const cur = p.getPlaybackQuality?.();
      if (on) {
        if (!lowered && cur && cur !== "tiny" && cur !== "unknown") savedQuality = cur;
        lowered = true;
        if (cur !== "tiny") p.setPlaybackQualityRange("tiny", "tiny");
        return;
      }
      if (!lowered) return;
      lowered = false;
      const levels = p.getAvailableQualityLevels?.() || [];
      const want = QUALITY.indexOf(savedQuality || (devicePixelRatio > 1.5 ? "hd720" : "large"));
      const fit = levels.filter((q) => QUALITY.includes(q) && QUALITY.indexOf(q) <= want)
        .sort((a, b) => QUALITY.indexOf(b) - QUALITY.indexOf(a))[0];
      if (fit) p.setPlaybackQualityRange(fit, fit);
    },
    state() { post("state", readState()); },
  };

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || m[TAG] !== "in" || !Object.hasOwn(commands, m.type)) return;
    try { commands[m.type](m.data || {}); } catch (_) { /* player API changed */ }
  });

  // Push state only when it changes.
  let last = "";
  setInterval(() => {
    const s = readState();
    const key = JSON.stringify(s);
    if (key !== last) {
      last = key;
      post("state", s);
    }
  }, 400);
})();
