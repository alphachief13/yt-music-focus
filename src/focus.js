/**
 * Focus — the listening layer.
 *
 * Builds a tiny UI over youtube.com (title, artist, progress, ‹ II ›, ♡,
 * volume), hides everything else through focus.css, and keeps a local
 * library (liked, playlists, recently played) in chrome.storage.local.
 *
 * Playback is YouTube's: we read the page's <video> for time/paused state and
 * ask the MAIN-world bridge (bridge.js) to call the player's own API.
 */
(() => {
  "use strict";

  const FX = globalThis.FX;
  const { t, fmtTime, parseTitle, cache } = FX;
  const ID_RE = /^[\w-]{11}$/;
  const root = document.documentElement;
  const IDLE_MS = 3500;

  // ======================================================================
  // helpers
  // ======================================================================
  const NS = "http://www.w3.org/2000/svg";
  const HEART =
    "M12 19.5s-6.8-4.2-8.9-8.3C1.6 8.3 3.2 5 6.3 4.7c1.9-.2 3.7.9 5.7 3 2-2.1 3.8-3.2 5.7-3 3.1.3 4.7 3.6 3.2 6.5-2.1 4.1-8.9 8.3-8.9 8.3Z";
  const ICONS = {
    menu: [["path", { d: "M4.5 7.5h15M4.5 12h15M4.5 16.5h15" }]],
    prev: [["path", { d: "M18 6.8v10.4a.6.6 0 0 1-.94.5L9.6 12.5a.6.6 0 0 1 0-1l7.46-5.2a.6.6 0 0 1 .94.5Z" }], ["path", { d: "M6.5 6v12" }]],
    next: [["path", { d: "M6 6.8v10.4a.6.6 0 0 0 .94.5l7.46-5.2a.6.6 0 0 0 0-1L6.94 6.3a.6.6 0 0 0-.94.5Z" }], ["path", { d: "M17.5 6v12" }]],
    play: [["path", { class: "f", d: "M7.5 5.3v13.4a.7.7 0 0 0 1.06.6l10.6-6.7a.7.7 0 0 0 0-1.2L8.56 4.7a.7.7 0 0 0-1.06.6Z" }]],
    pause: [["rect", { class: "f", x: "6.6", y: "5", width: "2.7", height: "14", rx: "1" }], ["rect", { class: "f", x: "14.7", y: "5", width: "2.7", height: "14", rx: "1" }]],
    heart: [["path", { d: HEART }]],
    plus: [["path", { d: "M12 6.5v11M6.5 12h11" }]],
    vol: [["path", { d: "M4.5 9.6h3l4.2-3.4v11.6l-4.2-3.4h-3z" }], ["path", { d: "M15.2 9.4a3.6 3.6 0 0 1 0 5.2M17.7 7a7 7 0 0 1 0 10" }]],
    mute: [["path", { d: "M4.5 9.6h3l4.2-3.4v11.6l-4.2-3.4h-3z" }], ["path", { d: "m15.5 10 4 4m0-4-4 4" }]],
    x: [["path", { d: "M7 7l10 10M17 7 7 17" }]],
    back: [["path", { d: "M14.5 6.5 9 12l5.5 5.5" }]],
    check: [["path", { d: "m6.5 12.5 3.5 3.5 7.5-8" }]],
    // video modes (the icon shows the current one)
    video: [["rect", { x: "2.8", y: "5.2", width: "18.4", height: "13.6", rx: "2.6" }], ["path", { class: "f", d: "M10.2 9.3v5.4l4.6-2.7z" }]],
    cover: [["rect", { x: "3.5", y: "3.5", width: "17", height: "17", rx: "2.6" }], ["circle", { cx: "12", cy: "12", r: "3.4" }], ["circle", { class: "f", cx: "12", cy: "12", r: "0.9" }]],
    dark: [["path", { d: "M19.6 14.6A7.6 7.6 0 0 1 9.4 4.4a7.7 7.7 0 1 0 10.2 10.2Z" }]],
  };
  const VMODE_LABEL = { video: "vVideo", cover: "vCover", dark: "vDark" };
  const VMODE_SHORT = { video: "vVideoShort", cover: "vCoverShort", dark: "vDarkShort" };

  function icon(name) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of ICONS[name]) {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    }
    return svg;
  }

  /** Tiny DOM builder. Text always goes through textContent. */
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  const button = (cls, label, iconName, onclick, extra = {}) =>
    h("button", { type: "button", class: cls, "aria-label": label, title: label, onclick, ...extra }, iconName ? icon(iconName) : null);

  const send = (type, data = {}) => window.postMessage({ "fx-bridge": "in", type, data }, location.origin);
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const urlId = () => {
    const v = new URLSearchParams(location.search).get("v");
    return ID_RE.test(v || "") ? v : null;
  };
  const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

  const session = {
    get(key, fallback) {
      try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; }
    },
    set(key, value) {
      try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* quota / disabled */ }
    },
  };

  // ======================================================================
  // state
  // ======================================================================
  const S = {
    route: "page",          // watch | page | pass
    id: null,               // current video id (also while in miniplayer)
    meta: { title: "", artist: "", channel: "", duration: 0 },
    bridge: null,
    playing: false,
    ad: false,
    view: null,             // open panel view, or null
    menuOpen: false,
    popOpen: false,
    dragging: false,
    volDragging: 0,
    lastMove: Date.now(),
    results: [],
    resultsSig: "",
    recorded: null,         // id last recorded into "recent"
    qTick: 0,
  };
  let video = null;
  const E = {}; // element refs

  // ======================================================================
  // routing
  // ======================================================================
  const PASS = /^\/(account|premium|paid_memberships|reporthistory|upload|signin|logout|t\/|about|howyoutubeworks|creators|copyright|live_chat|redirect|attribution_link|oops|embed)/;

  function routeOf(path) {
    if (path === "/watch") return "watch";
    if (PASS.test(path)) return "pass";
    return "page";
  }

  /** Shorts are a feed, not a song: send them to the normal watch page. */
  function redirectShorts() {
    if (!cache.settings.focus) return false;
    const m = location.pathname.match(/^\/shorts\/([\w-]{11})/);
    if (!m) return false;
    location.replace(`/watch?v=${m[1]}`);
    return true;
  }

  let lastHref = "";
  function onRoute() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    if (redirectShorts()) return;
    S.route = routeOf(location.pathname);
    apply();
    if (!E.ui) return;
    if (S.route === "watch") {
      const id = urlId();
      if (id && id !== S.id) setCurrent(id, null);
    }
    renderHome();
    send("state");
    nudgeResize();
  }

  function nudgeResize() {
    requestAnimationFrame(() => send("resize"));
    setTimeout(() => send("resize"), 350);
  }

  /** Mirrors settings + route + fullscreen into <html> classes. */
  function apply() {
    const s = cache.settings;
    const fs = !!document.fullscreenElement;
    const on = s.focus && S.route !== "pass" && !fs;
    const was = root.classList.contains("fx-on");
    const c = root.classList;
    c.toggle("fx-enabled", !!s.focus);
    c.toggle("fx-on", on);
    c.toggle("fx-fs", fs);
    c.toggle("fx-watch", S.route === "watch");
    c.toggle("fx-page", S.route === "page");
    c.toggle("fx-results", S.route === "page" && location.pathname === "/results");
    c.toggle("fx-ambient", !!s.ambient);
    c.toggle("fx-ad", S.ad);
    c.toggle("fx-vcover", s.videoMode === "cover");
    c.toggle("fx-vdark", s.videoMode === "dark");
    syncQuality();
    renderVMode();
    if (!on) {
      c.remove("fx-idle");
      if (S.view) closePanel();
      closeMenu();
      closePop();
    }
    if (was !== on) nudgeResize();
    if (E.focus) {
      E.focus.setAttribute("aria-pressed", String(!!s.focus));
      E.focus.title = `${t("sFocus")} · ${t("shortcut")}`;
    }
  }

  /** Video hidden => ask YouTube for the smallest rendition; restore otherwise. */
  let lowSent = null;
  function syncQuality(force) {
    const low = root.classList.contains("fx-on") && S.route === "watch" && cache.settings.videoMode !== "video";
    if (low === lowSent && !force) return;
    lowSent = low;
    send("lowq", { on: low });
  }

  function cycleVideoMode() {
    const modes = FX.VIDEO_MODES;
    const next = modes[(modes.indexOf(cache.settings.videoMode) + 1) % modes.length];
    FX.setSetting("videoMode", next);
    apply();
    toast(t(VMODE_LABEL[next]));
  }

  function setCover(id) {
    const img = E.coverImg;
    img.classList.remove("is-loaded");
    img.dataset.step = "0";
    img.src = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  }

  // ======================================================================
  // UI skeleton
  // ======================================================================
  function build() {
    E.back = h("div", { id: "fx-back", "aria-hidden": "true" }, (E.backImg = h("img", { alt: "" })));
    E.backImg.addEventListener("load", () => E.backImg.classList.add("is-loaded"));

    // video off: artwork (or nothing) laid exactly over the player
    E.cover = h("div", { id: "fx-cover", "aria-hidden": "true" }, (E.coverImg = h("img", { alt: "" })));
    const coverFallback = () => {
      if (E.coverImg.dataset.step !== "0" || !S.id) return false;
      E.coverImg.dataset.step = "1";
      E.coverImg.src = `https://i.ytimg.com/vi/${S.id}/hqdefault.jpg`;
      return true;
    };
    // maxresdefault doesn't exist for every video (YouTube serves a 120px placeholder).
    E.coverImg.addEventListener("load", () => {
      if (E.coverImg.naturalWidth <= 120 && coverFallback()) return;
      E.coverImg.classList.add("is-loaded");
    });
    E.coverImg.addEventListener("error", coverFallback);

    // corners
    E.menuBtn = button("fx-menu-btn fx-fade", t("menu"), "menu", () => (S.menuOpen ? closeMenu() : openMenu()), { "aria-expanded": "false", "aria-haspopup": "true" });
    E.focus = h("button", { type: "button", class: "fx-focus fx-fade", "aria-pressed": "true", onclick: () => FX.setSetting("focus", !cache.settings.focus) },
      h("span", { text: t("focus") }), h("span", { class: "fx-dot" }));

    E.menu = h("nav", { class: "fx-menu", "aria-label": t("menu") },
      h("button", { type: "button", text: t("search"), onclick: goSearch }),
      h("span", { class: "fx-sep" }),
      h("button", { type: "button", text: t("library"), "data-view": "library", onclick: () => openPanel("library") }),
      h("button", { type: "button", text: t("liked"), "data-view": "liked", onclick: () => openPanel("liked") }),
      h("button", { type: "button", text: t("playlists"), "data-view": "playlists", onclick: () => openPanel("playlists") }),
      h("span", { class: "fx-sep" }),
      h("button", { type: "button", text: t("settings"), "data-view": "settings", onclick: () => openPanel("settings") }));

    // stage (watch page)
    E.title = h("div", { class: "fx-title" });
    E.artist = h("div", { class: "fx-artist" });
    E.fill = h("div", { class: "fx-fill" });
    E.bar = h("div", { class: "fx-bar", role: "slider", tabindex: "0", "aria-label": t("seek"), "aria-valuemin": "0" }, E.fill, h("div", { class: "fx-knob" }));
    E.cur = h("span", { text: "0:00" });
    E.dur = h("span", { text: "0:00" });
    E.playIcon = icon("play");
    E.pauseIcon = icon("pause");
    E.play = h("button", { type: "button", class: "fx-ctl fx-play", "aria-label": t("play"), title: t("play"), onclick: () => send("toggle") }, E.playIcon, E.pauseIcon);
    E.heart = button("fx-act fx-heart", t("like"), "heart", toggleLike, { "aria-pressed": "false" });
    E.plus = button("fx-act fx-plus", t("playlists"), "plus", () => (S.popOpen ? closePop() : openPop()), { "aria-expanded": "false", "aria-haspopup": "true" });
    E.vmode = button("fx-act fx-vmode", t("sVideo"), null, cycleVideoMode);
    E.actions = h("div", { class: "fx-actions fx-fade" }, E.vmode, E.heart, E.plus);

    E.stage = h("main", { class: "fx-stage" },
      E.title,
      E.artist,
      h("div", { class: "fx-progress" }, E.bar, h("div", { class: "fx-times fx-fade" }, E.cur, E.dur)),
      h("div", { class: "fx-controls fx-fade" },
        button("fx-ctl", t("prev"), "prev", prev),
        E.play,
        button("fx-ctl", t("next"), "next", next)),
      E.actions);

    // volume
    E.volIcon = icon("vol");
    E.muteIcon = icon("mute");
    E.volBtn = h("button", { type: "button", class: "fx-vol-btn", "aria-label": t("mute"), title: t("mute"), onclick: toggleMute }, E.volIcon, E.muteIcon);
    E.range = h("input", { type: "range", class: "fx-range", min: "0", max: "100", step: "1", value: "100", "aria-label": t("volume") });
    E.volume = h("div", { class: "fx-volume fx-fade" }, E.volBtn, E.range);

    // home / search
    E.input = h("input", { type: "search", class: "fx-input", placeholder: t("searchPh"), "aria-label": t("search"), autocomplete: "off", spellcheck: "false", maxlength: "200" });
    E.continue = h("button", { type: "button", class: "fx-continue", hidden: true });
    E.results = h("div", { class: "fx-results-list", role: "list" });
    E.home = h("section", { class: "fx-home" },
      h("div", { class: "fx-word", text: "focus" }),
      h("form", { class: "fx-search", role: "search", onsubmit: (e) => { e.preventDefault(); search(E.input.value); } }, E.input),
      E.continue,
      E.results);

    // now playing line (pages other than /watch)
    E.nowLabel = h("button", { type: "button", class: "fx-now-label", onclick: () => S.id && send("navigate", { id: S.id }) });
    E.nowPlay = h("button", { type: "button", class: "fx-ctl", "aria-label": t("play"), onclick: () => send("toggle") }, icon("play"), icon("pause"));
    E.now = h("div", { class: "fx-now" }, E.nowPlay, E.nowLabel);

    // panel
    E.panelTitle = h("div", { class: "fx-panel-title", id: "fx-panel-title" });
    E.panelBack = button("fx-act", t("back"), "back", () => openPanel(S.backTo || "library"));
    E.panelBody = h("div", { class: "fx-panel-body" });
    E.panel = h("aside", { class: "fx-panel", role: "dialog", "aria-labelledby": "fx-panel-title" },
      h("div", { class: "fx-panel-head" }, E.panelBack, E.panelTitle, button("fx-act", t("close"), "x", closePanel)),
      E.panelBody);

    E.toast = h("div", { class: "fx-toast", role: "status", "aria-live": "polite" });
    E.file = h("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: importFile });

    E.ui = h("div", { id: "fx-ui" }, E.stage, E.volume, E.home, E.now, E.menuBtn, E.focus, E.menu, E.panel, E.toast, E.file);

    document.body.append(E.back, E.cover, E.ui);
    wire();
    apply();
    renderAll();
  }

  // ======================================================================
  // wiring
  // ======================================================================
  function wire() {
    // --- seek bar
    const dur = () => duration();
    const frac = (e) => {
      const r = E.bar.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1);
    };
    E.bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || S.ad) return;
      S.dragging = true;
      E.bar.setPointerCapture(e.pointerId);
      E.bar.classList.add("is-drag");
      previewSeek(frac(e));
    });
    E.bar.addEventListener("pointermove", (e) => S.dragging && previewSeek(frac(e)));
    const end = (e, commit) => {
      if (!S.dragging) return;
      S.dragging = false;
      E.bar.classList.remove("is-drag");
      if (commit && dur()) send("seek", { t: frac(e) * dur() });
    };
    E.bar.addEventListener("pointerup", (e) => end(e, true));
    E.bar.addEventListener("pointercancel", (e) => end(e, false));
    E.bar.addEventListener("keydown", (e) => {
      if (!video || S.ad) return;
      const step = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5, PageDown: -30, PageUp: 30 }[e.key];
      let target = null;
      if (step) target = video.currentTime + step;
      else if (e.key === "Home") target = 0;
      else if (e.key === "End") target = dur() - 1;
      if (target == null) return;
      e.preventDefault();
      send("seek", { t: clamp(target, 0, dur()) });
    });

    // --- volume
    E.range.addEventListener("input", () => {
      const v = Number(E.range.value);
      S.volDragging = Date.now();
      paintVolume(v, v === 0);
      send("volume", { v });
    });
    E.volume.addEventListener("wheel", (e) => {
      e.preventDefault();
      const v = clamp(Number(E.range.value) + (e.deltaY < 0 ? 5 : -5), 0, 100);
      E.range.value = v;
      S.volDragging = Date.now();
      paintVolume(v, v === 0);
      send("volume", { v });
    }, { passive: false });

    // --- keyboard isolation: our controls must not trigger YouTube hotkeys
    const isolate = (e) => {
      const tg = e.target;
      if (e.key === "Escape") return;
      if (tg.matches("input")) return e.stopPropagation();
      if (tg.matches(".fx-bar") && /^(Arrow|Home|End|Page)/.test(e.key)) return e.stopPropagation();
      if (tg.matches("button") && (e.key === " " || e.key === "Enter")) e.stopPropagation();
    };
    for (const type of ["keydown", "keypress", "keyup"]) E.ui.addEventListener(type, isolate);

    // Mouse clicks shouldn't leave focus rings on buttons (keyboard still does).
    E.ui.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b && e.detail > 0) b.blur();
    });

    // --- global
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (S.popOpen) closePop();
      else if (S.menuOpen) closeMenu();
      else if (S.view) closePanel();
      else if (document.activeElement?.closest?.("#fx-ui")) document.activeElement.blur();
      else return;
      e.stopPropagation();
    }, true);

    document.addEventListener("pointerdown", (e) => {
      const inside = (el) => el && el.contains(e.target);
      if (S.menuOpen && !inside(E.menu) && !inside(E.menuBtn)) closeMenu();
      if (S.popOpen && !inside(E.pop) && !inside(E.plus)) closePop();
      if (S.view && !inside(E.panel) && !inside(E.menu) && !inside(E.menuBtn) && !inside(E.stage) && !inside(E.toast)) closePanel();
    }, true);

    for (const type of ["pointermove", "pointerdown", "keydown", "wheel"]) {
      window.addEventListener(type, () => {
        S.lastMove = Date.now();
        if (root.classList.contains("fx-idle")) root.classList.remove("fx-idle");
      }, { capture: true, passive: true });
    }

    document.addEventListener("fullscreenchange", apply);
    document.addEventListener("yt-navigate-finish", onRoute);
    window.addEventListener("popstate", onRoute);

    window.addEventListener("message", (e) => {
      if (e.source !== window) return;
      const m = e.data;
      if (m && m["fx-bridge"] === "out" && m.type === "state") onBridge(m.data);
    });

    FX.onChange((changes) => {
      if (changes.settings) apply();
      if (changes.settings?.newValue?.desktop && !changes.settings.oldValue?.desktop) reportDesktop(true);
      renderLike();
      renderHome();
      if (S.view) renderPanel();
      if (S.popOpen) renderPop();
    });

    setInterval(tick, 250);
    requestAnimationFrame(frame);
  }

  // ======================================================================
  // player state
  // ======================================================================
  function getPlayer() {
    return document.getElementById("movie_player");
  }

  function getVideo() {
    const v = document.querySelector("#movie_player video.html5-main-video") || document.querySelector("video.html5-main-video");
    if (v !== video) {
      video = v;
      if (v && !v.__fx) {
        v.__fx = true;
        for (const ev of ["play", "pause", "playing", "ended", "emptied", "loadedmetadata"]) v.addEventListener(ev, onVideoEvent);
        v.addEventListener("volumechange", () => send("state"));
      }
    }
    return video;
  }

  function onVideoEvent(e) {
    renderPlay();
    if (e.type === "ended" && !S.ad) onEnded();
  }

  function duration() {
    if (S.ad) return video && Number.isFinite(video.duration) ? video.duration : 0;
    const vd = video && Number.isFinite(video.duration) ? video.duration : 0;
    return S.meta.duration || vd;
  }

  function onBridge(st) {
    if (!st || typeof st !== "object") return;
    S.bridge = st;
    const id = ID_RE.test(st.id || "") ? st.id : null;
    // While on /watch, trust the URL (getVideoData can briefly describe an ad
    // or the previous video during transitions).
    const wanted = S.route === "watch" ? urlId() : id;
    if (id && id === wanted) setCurrent(id, st);
    if (!S.volDragging || Date.now() - S.volDragging > 800) {
      S.volDragging = 0;
      const muted = !!st.muted;
      E.range.value = muted ? 0 : clamp(Math.round(st.volume) || 0, 0, 100);
      paintVolume(Number(E.range.value), muted || Number(E.range.value) === 0);
    }
  }

  /** Updates the current song; `st` is bridge state (may be null). */
  function setCurrent(id, st) {
    const changed = id !== S.id;
    if (changed) {
      S.id = id;
      S.meta = { title: "", artist: "", channel: "", duration: 0 };
      E.backImg.classList.remove("is-loaded");
      E.backImg.src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
      setCover(id);
      pushHistory(id);
      syncQuality(true); // a new video may start at YouTube's default quality
    }
    if (st && st.title) {
      const { title, artist } = parseTitle(st.title, st.author);
      S.meta = { title, artist, channel: str(st.author), duration: Number(st.duration) || S.meta.duration };
    } else if (!S.meta.title) {
      const saved = cache.songs[id];
      if (saved) S.meta = { title: saved.title, artist: saved.artist, channel: saved.channel || "", duration: saved.duration || 0 };
    }
    renderInfo();
    if (S.meta.title && S.route === "watch") record(id);
  }

  function readPlaying() {
    return !!(video && !video.paused && !video.ended);
  }

  function tick() {
    onRoute(); // cheap: compares href
    getVideo();
    const p = getPlayer();
    const ad = !!p && (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting"));
    if (ad !== S.ad) {
      S.ad = ad;
      root.classList.toggle("fx-ad", ad);
    }
    const playing = readPlaying();
    if (playing !== S.playing) renderPlay();

    const s = cache.settings;
    const busy = S.view || S.menuOpen || S.popOpen || S.dragging || document.activeElement?.matches?.("#fx-ui input");
    const idle = s.autoHide && root.classList.contains("fx-on") && S.route === "watch" && S.playing && !busy && Date.now() - S.lastMove > IDLE_MS;
    root.classList.toggle("fx-idle", !!idle);

    if (lowSent && ++S.qTick % 8 === 0) syncQuality(true);
    reportDesktop();
    if (S.route === "page" && location.pathname === "/results") scrapeResults();
    renderNow();
    if (!S.playing) renderProgress();
  }

  function frame() {
    if (S.playing && S.route === "watch" && !document.hidden) renderProgress();
    requestAnimationFrame(frame);
  }

  // ======================================================================
  // playback actions
  // ======================================================================
  const getCtx = () => session.get("fx-ctx", null);
  const setCtx = (ctx) => session.set("fx-ctx", ctx);

  function pushHistory(id) {
    const hist = session.get("fx-hist", []);
    if (hist[hist.length - 1] !== id) {
      hist.push(id);
      session.set("fx-hist", hist.slice(-100));
    }
  }

  /** Play `id`, optionally inside a list context (liked, playlist, recent, results). */
  function play(id, ctx) {
    if (!ID_RE.test(id || "")) return;
    setCtx(ctx && Array.isArray(ctx.ids) ? { ids: ctx.ids.filter((x) => ID_RE.test(x)).slice(0, 500) } : null);
    if (id === S.id && S.route === "watch") {
      if (video?.paused) send("toggle");
      return;
    }
    send("navigate", { id });
  }

  function prev() {
    if (video && video.currentTime > 3) return send("seek", { t: 0 });
    const ctx = getCtx();
    const i = ctx ? ctx.ids.indexOf(S.id) : -1;
    if (i > 0) return send("navigate", { id: ctx.ids[i - 1] });
    if (S.bridge?.playlist) return send("prev");
    const hist = session.get("fx-hist", []);
    const j = hist.lastIndexOf(S.id);
    if (j > 0) {
      session.set("fx-hist", hist.slice(0, j - 1)); // the target is re-pushed when it loads
      return send("navigate", { id: hist[j - 1] });
    }
    send("seek", { t: 0 });
  }

  function next() {
    const ctx = getCtx();
    const i = ctx ? ctx.ids.indexOf(S.id) : -1;
    if (i >= 0 && i < ctx.ids.length - 1) return send("navigate", { id: ctx.ids[i + 1] });
    send("next"); // YouTube's playlist / up-next
  }

  function onEnded() {
    const ctx = getCtx();
    const i = ctx ? ctx.ids.indexOf(S.id) : -1;
    if (i >= 0 && i < ctx.ids.length - 1) send("navigate", { id: ctx.ids[i + 1] });
  }

  function toggleMute() {
    const muted = !(S.bridge?.muted || Number(E.range.value) === 0);
    S.volDragging = Date.now();
    if (!muted && Number(E.range.value) === 0) {
      E.range.value = 50;
      send("volume", { v: 50 });
    }
    send("mute", { m: muted });
    paintVolume(muted ? 0 : Number(E.range.value), muted);
    if (S.bridge) S.bridge.muted = muted;
  }

  function search(q) {
    q = String(q || "").trim();
    if (q) send("search", { q });
  }

  function goSearch() {
    closeMenu();
    closePanel();
    if (S.route === "page") {
      E.input.focus();
      E.input.select();
    } else {
      send("home");
      setTimeout(() => E.input.focus(), 600);
    }
  }

  // ======================================================================
  // library
  // ======================================================================
  function songFromCurrent() {
    const m = S.meta;
    return {
      id: S.id,
      title: str(m.title),
      artist: str(m.artist),
      channel: str(m.channel),
      thumb: FX.thumbUrl(S.id),
      duration: Math.round(m.duration) || cache.songs[S.id]?.duration || 0,
    };
  }

  /** Drop songs that are no longer liked, in a playlist, or in history. */
  function prune(songs, recent, playlists) {
    const keep = new Set(recent);
    for (const p of playlists) for (const id of p.ids) keep.add(id);
    for (const [id, s] of Object.entries(songs)) if (!s.liked && !keep.has(id)) delete songs[id];
    return songs;
  }

  function record(id) {
    const known = cache.songs[id];
    const dur = Math.round(S.meta.duration);
    if (S.recorded === id) {
      // Fill in duration / title once they become available.
      if (known && ((dur && known.duration !== dur) || known.title !== S.meta.title)) {
        FX.save({ songs: { ...cache.songs, [id]: { ...known, ...songFromCurrent() } } });
      }
      return;
    }
    S.recorded = id;
    const songs = { ...cache.songs, [id]: { ...(known || {}), ...songFromCurrent(), playedAt: Date.now() } };
    const recent = [id, ...cache.recent.filter((x) => x !== id)].slice(0, 50);
    FX.save({ songs: prune(songs, recent, cache.playlists), recent });
  }

  function toggleLike() {
    if (!S.id) return;
    const known = cache.songs[S.id] || songFromCurrent();
    const liked = !known.liked;
    const songs = { ...cache.songs, [S.id]: { ...known, ...songFromCurrent(), liked, likedAt: liked ? Date.now() : undefined } };
    FX.save({ songs: prune(songs, cache.recent, cache.playlists) });
    renderLike();
    if (liked) {
      E.heart.classList.remove("is-pop");
      void E.heart.offsetWidth;
      E.heart.classList.add("is-pop");
    }
  }

  const likedSongs = () =>
    Object.values(cache.songs).filter((s) => s.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
  const songsOf = (ids) => ids.map((id) => cache.songs[id]).filter(Boolean);

  function createPlaylist(name, withCurrent) {
    name = str(name.trim(), 80);
    if (!name) return null;
    const pl = { id: `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, ids: [], createdAt: Date.now() };
    let songs = cache.songs;
    if (withCurrent && S.id) {
      pl.ids.push(S.id);
      songs = { ...songs, [S.id]: { ...(songs[S.id] || {}), ...songFromCurrent() } };
    }
    FX.save({ playlists: [...cache.playlists, pl], songs });
    return pl;
  }

  function toggleInPlaylist(plId, id) {
    let songs = cache.songs;
    const playlists = cache.playlists.map((p) => {
      if (p.id !== plId) return p;
      const has = p.ids.includes(id);
      if (!has && id === S.id) songs = { ...songs, [id]: { ...(songs[id] || {}), ...songFromCurrent() } };
      return { ...p, ids: has ? p.ids.filter((x) => x !== id) : [...p.ids, id] };
    });
    FX.save({ playlists, songs: prune({ ...songs }, cache.recent, playlists) });
  }

  function removeLike(id) {
    const s = cache.songs[id];
    if (!s) return;
    const songs = { ...cache.songs, [id]: { ...s, liked: false, likedAt: undefined } };
    FX.save({ songs: prune(songs, cache.recent, cache.playlists) });
  }

  function removeRecent(id) {
    const recent = cache.recent.filter((x) => x !== id);
    FX.save({ recent, songs: prune({ ...cache.songs }, recent, cache.playlists) });
  }

  function exportLibrary() {
    const data = { app: "focus", version: 1, exportedAt: new Date().toISOString(), songs: cache.songs, playlists: cache.playlists, recent: cache.recent };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = h("a", { href: url, download: `focus-library-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Validates and merges an exported library file. */
  async function importFile() {
    const file = E.file.files?.[0];
    E.file.value = "";
    if (!file || file.size > 5_000_000) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch (_) { return toast("✕"); }
    if (!data || typeof data !== "object") return toast("✕");

    const songs = { ...cache.songs };
    for (const [id, s] of Object.entries(data.songs || {})) {
      if (!ID_RE.test(id) || !s || typeof s !== "object") continue;
      const old = songs[id] || {};
      songs[id] = {
        ...old,
        id,
        title: str(s.title) || old.title || id,
        artist: str(s.artist) || old.artist || "",
        channel: str(s.channel) || old.channel || "",
        thumb: FX.thumbUrl(id),
        duration: Number.isFinite(s.duration) ? Math.max(0, Math.round(s.duration)) : old.duration || 0,
        liked: !!(old.liked || s.liked),
        likedAt: old.likedAt || (Number.isFinite(s.likedAt) ? s.likedAt : s.liked ? Date.now() : undefined),
        playedAt: Math.max(old.playedAt || 0, Number.isFinite(s.playedAt) ? s.playedAt : 0) || undefined,
      };
    }
    const playlists = [...cache.playlists];
    for (const p of Array.isArray(data.playlists) ? data.playlists : []) {
      if (!p || typeof p !== "object" || !str(p.name)) continue;
      const ids = (Array.isArray(p.ids) ? p.ids : []).filter((id) => ID_RE.test(id) && songs[id]);
      const existing = playlists.findIndex((x) => x.id === p.id);
      if (existing >= 0) {
        playlists[existing] = { ...playlists[existing], ids: [...new Set([...playlists[existing].ids, ...ids])] };
      } else {
        playlists.push({ id: str(p.id, 40) || `pl${Date.now().toString(36)}`, name: str(p.name, 80), ids, createdAt: Number(p.createdAt) || Date.now() });
      }
    }
    const incoming = (Array.isArray(data.recent) ? data.recent : []).filter((id) => ID_RE.test(id) && songs[id]);
    const recent = [...new Set([...cache.recent, ...incoming])].slice(0, 50);
    await FX.save({ songs: prune(songs, recent, playlists), playlists, recent });
    toast(t("imported"));
  }

  // ======================================================================
  // rendering
  // ======================================================================
  function renderAll() {
    renderInfo();
    renderPlay();
    renderProgress();
    renderHome();
    renderNow();
  }

  function renderInfo() {
    if (!E.title) return;
    const fallback = S.route === "watch" ? document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "") : "";
    const parsed = S.meta.title ? S.meta : parseTitle(fallback === "YouTube" ? "" : fallback, "");
    E.title.textContent = parsed.title || "";
    E.artist.textContent = parsed.artist || "";
    E.title.title = S.meta.title ? `${S.meta.title}${S.meta.channel ? ` · ${S.meta.channel}` : ""}` : "";
    renderLike();
  }

  function renderVMode() {
    if (!E.vmode) return;
    const modes = FX.VIDEO_MODES;
    const mode = cache.settings.videoMode;
    const next = modes[(modes.indexOf(mode) + 1) % modes.length];
    if (E.vmode.dataset.mode !== mode) {
      E.vmode.dataset.mode = mode;
      E.vmode.replaceChildren(icon(mode));
    }
    const label = `${t(VMODE_LABEL[mode])} · ${t("vNext")} ${t(VMODE_SHORT[next]).toLowerCase()}`;
    E.vmode.setAttribute("aria-label", label);
    E.vmode.title = label;
  }

  function renderLike() {
    if (!E.heart) return;
    const liked = !!(S.id && cache.songs[S.id]?.liked);
    E.heart.classList.toggle("is-on", liked);
    E.heart.setAttribute("aria-pressed", String(liked));
    E.heart.setAttribute("aria-label", liked ? t("unlike") : t("like"));
    E.heart.title = liked ? t("unlike") : t("like");
  }

  function renderPlay() {
    S.playing = readPlaying();
    E.playIcon.style.display = S.playing ? "none" : "";
    E.pauseIcon.style.display = S.playing ? "" : "none";
    const label = S.playing ? t("pause") : t("play");
    E.play.setAttribute("aria-label", label);
    E.play.title = label;
    const [p, q] = E.nowPlay.querySelectorAll("svg");
    p.style.display = S.playing ? "none" : "";
    q.style.display = S.playing ? "" : "none";
    E.nowPlay.setAttribute("aria-label", label);
  }

  function setBar(f) {
    E.bar.style.setProperty("--p", `${(clamp(f, 0, 1) * 100).toFixed(3)}%`);
  }

  function previewSeek(f) {
    setBar(f);
    E.cur.textContent = fmtTime(f * duration());
  }

  function renderProgress() {
    if (!E.bar || S.dragging) return;
    const d = duration();
    const c = video ? video.currentTime || 0 : 0;
    setBar(d ? c / d : 0);
    if (S.ad) {
      const s = cache.settings;
      E.cur.textContent = s.adSkip ? t("adSkipping") : s.adMute ? t("adMuted") : t("ad");
      E.dur.textContent = d ? `−${fmtTime(d - c)}` : "";
    } else {
      E.cur.textContent = fmtTime(c);
      E.dur.textContent = d ? fmtTime(d) : "0:00";
    }
    E.bar.setAttribute("aria-valuemax", String(Math.round(d)));
    E.bar.setAttribute("aria-valuenow", String(Math.round(c)));
    E.bar.setAttribute("aria-valuetext", `${fmtTime(c)} / ${fmtTime(d)}`);
  }

  function paintVolume(v, muted) {
    E.range.style.setProperty("--v", `${muted ? 0 : v}%`);
    E.volIcon.style.display = muted ? "none" : "";
    E.muteIcon.style.display = muted ? "" : "none";
  }

  function renderHome() {
    if (!E.home) return;
    const onResults = location.pathname === "/results";
    if (onResults && document.activeElement !== E.input) {
      E.input.value = new URLSearchParams(location.search).get("search_query") || "";
    }
    if (!onResults) {
      E.results.replaceChildren();
      S.resultsSig = "";
    }
    // "Continue" — the last song, but only when nothing is playing already.
    const last = cache.recent.map((id) => cache.songs[id]).find(Boolean);
    const show = !onResults && last && !(video && S.id);
    E.continue.hidden = !show;
    if (show) {
      E.continue.replaceChildren(`${t("continue")} · `, h("b", { text: last.title }), last.artist ? ` — ${last.artist}` : "");
      E.continue.onclick = () => play(last.id, { ids: cache.recent.slice() });
    }
  }

  function renderNow() {
    if (!E.now) return;
    const on = S.route === "page" && !!S.id && !!video && !!S.meta.title && video.readyState > 0;
    E.now.classList.toggle("is-on", on);
    if (on) {
      const label = S.meta.artist ? `${S.meta.title} — ${S.meta.artist}` : S.meta.title;
      if (E.nowLabel.textContent !== label) E.nowLabel.textContent = label;
    }
  }

  // ---------------------------------------------------------------- results
  /** Reads YouTube's (hidden) search results and lists songs as plain text. */
  function scrapeResults() {
    const out = [];
    const seen = new Set();
    const items = document.querySelectorAll("ytd-search :is(ytd-video-renderer, yt-lockup-view-model)");
    for (const el of items) {
      if (el.closest("ytd-reel-shelf-renderer, ytd-shelf-renderer, ytd-horizontal-card-list-renderer, grid-shelf-view-model")) continue;
      const a = el.querySelector("a#video-title, a.yt-lockup-metadata-view-model__title, h3 a[href*='/watch']");
      const m = (a?.getAttribute("href") || "").match(/[?&]v=([\w-]{11})/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const raw = (a.getAttribute("title") || a.textContent || "").trim();
      const channel = (el.querySelector("ytd-channel-name #text, .yt-content-metadata-view-model__metadata-text, .yt-content-metadata-view-model-wiz__metadata-text")?.textContent || "").trim();
      const dur = (el.querySelector("ytd-thumbnail-overlay-time-status-renderer #text, ytd-thumbnail-overlay-time-status-renderer .badge-shape-wiz__text, .yt-badge-shape__text, .badge-shape-wiz__text")?.textContent || "").trim();
      const { title, artist } = parseTitle(raw, channel);
      out.push({ id: m[1], title, artist, dur: /^\d+(:\d\d)+$/.test(dur) ? dur : "" });
      if (out.length >= 12) break;
    }
    const sig = out.map((r) => r.id + r.dur).join();
    if (sig === S.resultsSig) return;
    S.resultsSig = sig;
    S.results = out;
    const ids = out.map((r) => r.id);
    E.results.replaceChildren(...out.map((r) => row(r, ids)));
  }

  // ---------------------------------------------------------------- rows
  function row(song, ids, onRemove) {
    const meta = song.duration ? fmtTime(song.duration) : song.dur || "";
    const el = h("div", { class: `fx-row${song.id === S.id ? " is-current" : ""}`, role: "listitem" },
      h("button", { type: "button", class: "fx-row-text", title: [song.title, song.artist].filter(Boolean).join(" — ") },
        h("span", { class: "fx-row-title", text: song.title || song.id }),
        song.artist ? h("span", { class: "fx-row-sub", text: song.artist }) : null),
      h("span", { class: "fx-row-meta", text: meta }),
      onRemove ? button("fx-row-x", t("remove"), "x", (e) => { e.stopPropagation(); onRemove(song.id); }) : h("span"));
    el.addEventListener("click", (e) => {
      if (!e.target.closest(".fx-row-x")) play(song.id, { ids });
    });
    return el;
  }

  const list = (songs, emptyText, onRemove) => {
    const ids = songs.map((s) => s.id);
    return songs.length
      ? h("div", { role: "list" }, songs.map((s) => row(s, ids, onRemove)))
      : h("div", { class: "fx-quiet", text: emptyText });
  };

  const link = (text, meta, onclick, cls = "") =>
    h("button", { type: "button", class: `fx-link ${cls}`, onclick }, h("span", { text }), meta != null ? h("span", { class: "fx-row-meta", text: String(meta) }) : null);

  const switchRow = (key, label) =>
    h("button", { type: "button", class: "fx-switch-row", role: "switch", "aria-checked": String(!!cache.settings[key]), onclick: () => FX.setSetting(key, !cache.settings[key]) },
      h("span", { text: label }), h("span", { class: "fx-switch" }));

  // ---------------------------------------------------------------- menu
  function openMenu() {
    S.menuOpen = true;
    E.menu.classList.add("is-open");
    E.menuBtn.setAttribute("aria-expanded", "true");
    for (const b of E.menu.querySelectorAll("[data-view]")) b.classList.toggle("is-active", S.view === b.dataset.view);
  }
  function closeMenu() {
    if (!E.menu) return;
    S.menuOpen = false;
    E.menu.classList.remove("is-open");
    E.menuBtn.setAttribute("aria-expanded", "false");
  }

  // ---------------------------------------------------------------- panel
  function openPanel(view) {
    S.view = view;
    S.confirm = null;
    closeMenu();
    root.classList.add("fx-panel-open");
    renderPanel();
    requestAnimationFrame(() => E.panel.querySelector("input")?.focus({ preventScroll: true }));
  }
  function closePanel() {
    S.view = null;
    root.classList.remove("fx-panel-open");
  }

  function renderPanel() {
    const v = S.view;
    if (!v) return;
    let title = "";
    let body = [];
    S.backTo = null;

    if (v === "library") {
      title = t("library");
      const filter = h("input", { type: "search", class: "fx-input", placeholder: t("filterPh"), "aria-label": t("filterPh"), value: S.filter || "", autocomplete: "off", spellcheck: "false" });
      const out = h("div");
      const renderFilter = () => {
        const q = (S.filter || "").toLowerCase().trim();
        if (!q) {
          out.replaceChildren(
            link(t("liked"), likedSongs().length, () => openPanel("liked")),
            link(t("playlists"), cache.playlists.length, () => openPanel("playlists")),
            link(t("recent"), cache.recent.length, () => openPanel("recent")));
          return;
        }
        const hits = Object.values(cache.songs).filter((s) => `${s.title} ${s.artist} ${s.channel}`.toLowerCase().includes(q)).slice(0, 50);
        out.replaceChildren(list(hits, t("empty")));
      };
      filter.addEventListener("input", () => { S.filter = filter.value; renderFilter(); });
      renderFilter();
      body = [filter, out];
    } else if (v === "liked") {
      title = t("liked");
      S.backTo = "library";
      body = [list(likedSongs(), t("emptyLiked"), removeLike)];
    } else if (v === "recent") {
      title = t("recent");
      S.backTo = "library";
      body = [list(songsOf(cache.recent), t("empty"), removeRecent)];
      if (cache.recent.length) {
        body.push(h("div", { class: "fx-group" }), link(t("clearRecent"), null, () => {
          FX.save({ recent: [], songs: prune({ ...cache.songs }, [], cache.playlists) });
        }, "is-danger"));
      }
    } else if (v === "playlists") {
      title = t("playlists");
      S.backTo = "library";
      const input = h("input", { type: "text", class: "fx-input", placeholder: t("newPlaylist"), "aria-label": t("playlistName"), maxlength: "80", autocomplete: "off" });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && createPlaylist(input.value, false)) input.value = "";
      });
      body = [
        input,
        cache.playlists.length
          ? cache.playlists.map((p) => link(p.name, p.ids.length, () => openPanel(`pl:${p.id}`)))
          : h("div", { class: "fx-quiet", text: t("empty") }),
      ];
    } else if (v.startsWith("pl:")) {
      const pl = cache.playlists.find((p) => p.id === v.slice(3));
      if (!pl) return openPanel("playlists");
      title = pl.name;
      S.backTo = "playlists";
      body = [list(songsOf(pl.ids), t("empty"), (id) => toggleInPlaylist(pl.id, id))];
      if (S.id && !pl.ids.includes(S.id) && S.meta.title) {
        body.unshift(link(`+ ${t("addCurrent")}`, null, () => toggleInPlaylist(pl.id, S.id)));
      }
      body.push(h("div", { class: "fx-group" }), link(S.confirm === pl.id ? t("sure") : t("deletePl"), null, () => {
        if (S.confirm !== pl.id) {
          S.confirm = pl.id;
          return renderPanel();
        }
        const playlists = cache.playlists.filter((p) => p.id !== pl.id);
        FX.save({ playlists, songs: prune({ ...cache.songs }, cache.recent, playlists) });
        openPanel("playlists");
      }, "is-danger"));
    } else if (v === "settings") {
      title = t("settings");
      body = [
        switchRow("focus", t("sFocus")),
        h("div", { class: "fx-seg-row" },
          h("div", { class: "fx-seg-label", id: "fx-seg-video", text: t("sVideo") }),
          h("div", { class: "fx-seg", role: "radiogroup", "aria-labelledby": "fx-seg-video" },
            FX.VIDEO_MODES.map((m) => h("button", {
              type: "button", role: "radio", "aria-checked": String(cache.settings.videoMode === m),
              text: t(VMODE_SHORT[m]), onclick: () => FX.setSetting("videoMode", m),
            })))),
        switchRow("autoHide", t("sAutoHide")),
        switchRow("ambient", t("sAmbient")),
        h("div", { class: "fx-group" }),
        switchRow("adMute", t("sAdMute")),
        switchRow("adBlackout", t("sAdBlackout")),
        switchRow("adSkip", t("sAdSkip")),
        h("div", { class: "fx-group" }),
        switchRow("desktop", t("sDesktop")),
        (E.deskStatus = h("div", { class: "fx-hint fx-desk-status", role: "status", "aria-live": "polite" })),
        h("div", { class: "fx-group" }),
        link(t("export"), null, exportLibrary),
        link(t("import"), null, () => E.file.click()),
        h("div", { class: "fx-hint", text: t("shortcut") }),
      ];
    }

    if (v === "settings") queueMicrotask(refreshDesktopStatus);

    // Keep focus on the filter input across re-renders.
    const hadFocus = document.activeElement?.closest?.(".fx-panel") && document.activeElement.matches("input");
    E.panelTitle.textContent = title;
    E.panelBack.hidden = !S.backTo;
    E.panelBody.replaceChildren(...body.flat());
    if (hadFocus) {
      const inp = E.panelBody.querySelector("input");
      if (inp) {
        inp.focus({ preventScroll: true });
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    }
  }

  // ---------------------------------------------------------------- popover
  function openPop() {
    if (!S.id) return;
    S.popOpen = true;
    E.plus.setAttribute("aria-expanded", "true");
    renderPop();
    E.pop.querySelector("button, input")?.focus({ preventScroll: true });
  }
  function closePop() {
    if (!S.popOpen) return;
    S.popOpen = false;
    E.plus.setAttribute("aria-expanded", "false");
    E.pop?.remove();
    E.pop = null;
  }
  function renderPop() {
    const input = h("input", { type: "text", class: "fx-input", placeholder: t("newPlaylist"), "aria-label": t("playlistName"), maxlength: "80", autocomplete: "off" });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && createPlaylist(input.value, true)) {
        toast(t("added"));
        closePop();
      }
    });
    const pop = h("div", { class: "fx-pop", role: "menu" },
      cache.playlists.map((p) => {
        const has = p.ids.includes(S.id);
        return h("button", { type: "button", class: "fx-link", role: "menuitemcheckbox", "aria-checked": String(has), onclick: () => toggleInPlaylist(p.id, S.id) },
          h("span", { text: p.name }),
          h("span", { class: `fx-row-meta${has ? " is-in" : ""}`, style: "width:14px;height:14px" }, has ? icon("check") : null));
      }),
      input);
    if (E.pop) E.pop.replaceWith(pop);
    else E.actions.append(pop);
    E.pop = pop;
  }

  /** Settings → desktop panel: shows whether the GNOME side answers. */
  function refreshDesktopStatus() {
    const el = E.deskStatus;
    if (!el || !el.isConnected) return;
    if (!cache.settings.desktop) return (el.textContent = t("deskOffHint"));
    if (!alive()) return (el.textContent = t("reloadPage"));
    el.textContent = t("deskConnecting");
    try {
      chrome.runtime.sendMessage({ fx: "desktopRetry" }).then((r) => {
        if (!el.isConnected) return;
        if (r?.status === "connected") el.textContent = t("deskOk");
        else if (r?.status === "connecting") { el.textContent = t("deskConnecting"); setTimeout(refreshDesktopStatus, 1500); }
        else el.textContent = t("deskMissing");
      }, () => (el.textContent = t("reloadPage")));
    } catch (_) {
      el.textContent = t("reloadPage");
    }
  }

  /** Opens the options page via the service worker. If the extension was
   *  reloaded after this tab loaded, this page lost its connection: say so. */
  function openOptions() {
    const stale = () => toast(t("reloadPage"));
    if (!alive()) return stale();
    try {
      chrome.runtime.sendMessage({ fx: "options" }).then((r) => { if (!r?.ok) stale(); }, stale);
    } catch (_) {
      stale();
    }
  }

  let toastTimer = 0;
  function toast(text) {
    E.toast.textContent = text;
    E.toast.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => E.toast.classList.remove("is-on"), 1600);
  }

  // ======================================================================
  // desktop panel (optional, see src/desktop.js) — only when enabled
  // ======================================================================
  let lastReport = "";
  let lastReportAt = 0;
  function reportDesktop(force) {
    if (!cache.settings.desktop || !alive()) return;
    if (!S.id || !video) return;
    const st = {
      id: S.id,
      title: S.meta.title,
      artist: S.meta.artist,
      duration: Math.round(duration()) || 0,
      position: Math.round(video.currentTime || 0),
      playing: S.playing,
      ad: S.ad,
      volume: S.bridge ? Math.round(S.bridge.volume) : 100,
      muted: !!S.bridge?.muted,
      queue: getCtx()?.ids || [],
    };
    const { position, ...rest } = st;
    const key = JSON.stringify(rest);
    const now = Date.now();
    // Changes go out immediately; the position once a second while playing.
    if (!force && key === lastReport && (!S.playing || now - lastReportAt < 1000)) return;
    lastReport = key;
    lastReportAt = now;
    try {
      chrome.runtime.sendMessage({ fx: "state", state: st }).catch(() => {});
    } catch (_) { /* extension reloaded */ }
  }

  function alive() {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  }

  function onDesktopCommand(m) {
    switch (m.cmd) {
      case "toggle": send("toggle"); break;
      case "next": next(); break;
      case "prev": prev(); break;
      case "seek": if (Number.isFinite(m.t) && !S.ad) send("seek", { t: m.t }); break;
      case "volume":
        if (Number.isFinite(m.v)) {
          send("volume", { v: m.v });
          if (m.v > 0 && S.bridge?.muted) send("mute", { m: false });
        }
        break;
      case "likeCurrent": toggleLike(); break;
      case "play":
        if (ID_RE.test(m.id || "")) play(m.id, Array.isArray(m.ids) ? { ids: m.ids } : null);
        break;
    }
    setTimeout(() => reportDesktop(true), 300);
  }

  if (alive() && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((m) => {
      if (m && m.fx === "cmd" && E.ui) onDesktopCommand(m);
    });
  }

  /** A tab opened from the panel receives its queue here. */
  function desktopHello() {
    if (!cache.settings.desktop || !alive()) return;
    try {
      chrome.runtime.sendMessage({ fx: "hello" }).then((r) => {
        if (r?.ctx?.ids) setCtx({ ids: r.ctx.ids.filter((x) => ID_RE.test(x)).slice(0, 500) });
      }).catch(() => {});
    } catch (_) { /* extension reloaded */ }
  }

  // ======================================================================
  // boot
  // ======================================================================
  // Classes go on <html> immediately (with defaults) so YouTube's feed never
  // flashes before the UI exists; the real settings follow a few ms later.
  S.route = routeOf(location.pathname);
  apply();

  FX.ready.then(() => {
    if (redirectShorts()) return;
    apply();
    const start = () => {
      if (E.ui) return;
      build();
      onRoute();
      send("state");
      desktopHello();
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  });

  // Exposed for the mockup / debugging only.
  globalThis.FX.ui = { S, E, openPanel, closePanel, openMenu, openPop, toast, render: renderAll };
})();
