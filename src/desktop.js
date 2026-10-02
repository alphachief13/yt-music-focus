/**
 * Focus — optional desktop bridge (GNOME panel), loaded by background.js.
 *
 * Off by default. When the user enables it on the options page (which also
 * requests the optional "nativeMessaging" permission), the service worker
 * connects to the native host installed by gnome/install.sh:
 *
 *   Focus tab (focus.js) ⇄ this worker ⇄ native host (GJS) ⇄ D-Bus ⇄ GNOME panel
 *
 * The panel only mirrors and remote-controls the Focus tab: playback is still
 * the YouTube player in the browser. Library edits go straight to
 * chrome.storage.local, the same data focus.js uses.
 */
"use strict";

const Desktop = (() => {
  const HOST = "io.github.alphachief13.focus";
  const ID_RE = /^[\w-]{11}$/;
  const RETRY_MS = 30_000;
  const { cache, save, ready, parseTitle } = globalThis.FX;

  let port = null;
  let status = "off"; // off | no-permission | connecting | connected | error
  let lastError = "";
  let lastAttempt = 0;
  let activeTab = null;
  const tabState = new Map(); // tabId -> last state from that tab
  const pendingCtx = new Map(); // tabId -> queue context for a tab we opened

  const enabled = () => !!cache.settings.desktop;
  const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

  // ------------------------------------------------------------- connection
  async function hasPermission() {
    try {
      return await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
    } catch (_) {
      return false;
    }
  }

  async function connect(force = false) {
    await ready;
    if (!enabled()) return disconnect("off");
    if (port) return;
    if (!force && Date.now() - lastAttempt < RETRY_MS) return;
    lastAttempt = Date.now();
    if (!(await hasPermission()) || typeof chrome.runtime.connectNative !== "function") {
      status = "no-permission";
      return;
    }
    status = "connecting";
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      port = null;
      status = "error";
      lastError = String(e?.message || e);
      return;
    }
    port.onMessage.addListener(onHostMessage);
    port.onDisconnect.addListener(() => {
      lastError = chrome.runtime.lastError?.message || "";
      port = null;
      status = enabled() ? "error" : "off";
    });
    // A port that survives the first tick means the host started.
    setTimeout(() => {
      if (port) {
        status = "connected";
        lastError = "";
      }
    }, 300);
    post({ type: "hello", version: chrome.runtime.getManifest().version });
    pushLibrary();
    pushState();
  }

  function disconnect(next = "off") {
    if (port) {
      try { port.disconnect(); } catch (_) { /* already gone */ }
    }
    port = null;
    status = next;
  }

  function post(msg) {
    if (!port) return;
    try { port.postMessage(msg); } catch (_) { /* port closed */ }
  }

  // ------------------------------------------------------------- state
  function pickActiveTab() {
    let best = null;
    for (const [id, s] of tabState) {
      if (!s?.id) continue;
      if (!best || (s.playing && !best.s.playing) || (s.playing === best.s.playing && s.at > best.s.at)) best = { id, s };
    }
    activeTab = best ? best.id : null;
  }

  function pushState() {
    const s = activeTab != null ? tabState.get(activeTab) : null;
    post({ type: "state", state: s ? { ...s, liked: !!cache.songs[s.id]?.liked, focus: !!cache.settings.focus, videoMode: cache.settings.videoMode } : null });
  }

  function onTabState(tabId, state) {
    if (!state || typeof state !== "object") return;
    tabState.set(tabId, { ...state, at: Date.now() });
    if (state.playing || activeTab == null || !tabState.get(activeTab)?.id) activeTab = tabId;
    if (activeTab !== tabId && !tabState.get(activeTab)?.playing) pickActiveTab();
    if (activeTab === tabId) pushState();
  }

  function forgetTab(tabId) {
    pendingCtx.delete(tabId);
    if (!tabState.delete(tabId)) return;
    if (activeTab === tabId) {
      pickActiveTab();
      pushState();
    }
  }

  // ------------------------------------------------------------- library
  const track = (s) => ({ videoId: s.id, title: s.title || s.id, artist: s.artist || "", duration: Number(s.duration) || 0 });

  function libraryPayload() {
    const songs = cache.songs;
    return {
      liked: Object.values(songs).filter((s) => s.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(track),
      playlists: cache.playlists.map((p) => ({ id: p.id, name: p.name, tracks: p.ids.map((id) => songs[id]).filter(Boolean).map(track) })),
      recent: cache.recent.map((id) => songs[id]).filter(Boolean).map(track),
    };
  }

  function pushLibrary() {
    post({ type: "library", library: libraryPayload() });
  }

  /** Same pruning rule as focus.js: keep liked, in a playlist, or in history. */
  function prune(songs, recent, playlists) {
    const keep = new Set(recent);
    for (const p of playlists) for (const id of p.ids) keep.add(id);
    for (const [id, s] of Object.entries(songs)) if (!s.liked && !keep.has(id)) delete songs[id];
    return songs;
  }

  function songFrom(t) {
    const id = t?.videoId;
    if (!ID_RE.test(id || "")) return null;
    const old = cache.songs[id] || {};
    return {
      ...old,
      id,
      title: str(t.title) || old.title || id,
      artist: str(t.artist) || old.artist || "",
      channel: old.channel || str(t.channel) || str(t.artist),
      thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      duration: Number.isFinite(t.duration) && t.duration > 0 ? Math.round(t.duration) : old.duration || 0,
    };
  }

  async function lib(op, a) {
    await ready;
    const songs = { ...cache.songs };
    let playlists = cache.playlists;
    const recent = cache.recent;
    switch (op) {
      case "like": {
        const s = songFrom(a.track);
        if (!s) return;
        songs[s.id] = { ...s, liked: true, likedAt: Date.now() };
        break;
      }
      case "unlike": {
        if (!songs[a.id]) return;
        songs[a.id] = { ...songs[a.id], liked: false, likedAt: undefined };
        break;
      }
      case "createPlaylist": {
        const name = str(String(a.name || "").trim(), 80);
        if (!name) return;
        const id = /^[\w-]{1,40}$/.test(a.id || "") ? a.id : `pl${Date.now().toString(36)}`;
        playlists = [...playlists, { id, name, ids: [], createdAt: Date.now() }];
        break;
      }
      case "deletePlaylist":
        playlists = playlists.filter((p) => p.id !== a.id);
        break;
      case "addToPlaylist": {
        const s = songFrom(a.track);
        if (!s) return;
        songs[s.id] = s;
        playlists = playlists.map((p) => (p.id === a.id && !p.ids.includes(s.id) ? { ...p, ids: [...p.ids, s.id] } : p));
        break;
      }
      case "removeFromPlaylist":
        playlists = playlists.map((p) => (p.id === a.id ? { ...p, ids: p.ids.filter((x) => x !== a.videoId) } : p));
        break;
      default:
        return;
    }
    await save({ songs: prune(songs, recent, playlists), playlists });
  }

  // ------------------------------------------------------------- search
  // Reads YouTube's own results page (ytInitialData) without touching the tab.
  function textOf(t) {
    if (!t) return "";
    if (typeof t === "string") return t;
    if (t.simpleText) return t.simpleText;
    if (t.content) return t.content;
    if (Array.isArray(t.runs)) return t.runs.map((r) => r.text).join("");
    return "";
  }

  function parseDuration(s) {
    if (!/^\d+(:\d\d)+$/.test(s || "")) return 0;
    return s.split(":").reduce((acc, n) => acc * 60 + Number(n), 0);
  }

  const SKIP = new Set(["reelShelfRenderer", "shelfRenderer", "horizontalCardListRenderer", "gridShelfViewModel", "shortsLockupViewModel", "secondarySearchContainerRenderer"]);

  function parseSearch(html, limit = 20) {
    const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s) || html.match(/window\["ytInitialData"\]\s*=\s*(\{.+?\});/s);
    if (!m) return [];
    let data;
    try { data = JSON.parse(m[1]); } catch (_) { return []; }
    const out = [];
    const seen = new Set();
    const add = (id, rawTitle, channel, durText) => {
      if (!ID_RE.test(id || "") || seen.has(id)) return;
      const duration = parseDuration(durText);
      if (!duration) return; // live streams, premieres
      seen.add(id);
      const { title, artist } = parseTitle(rawTitle, channel);
      out.push({ videoId: id, title, artist, channel, duration });
    };
    const walk = (node) => {
      if (out.length >= limit || !node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) walk(n); return; }
      for (const [k, v] of Object.entries(node)) {
        if (out.length >= limit) return;
        if (SKIP.has(k)) continue;
        if (k === "videoRenderer" && v?.videoId) {
          add(v.videoId, textOf(v.title), textOf(v.ownerText || v.longBylineText), textOf(v.lengthText));
        } else if (k === "lockupViewModel" && v?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
          const md = v.metadata?.lockupMetadataViewModel;
          const channel = textOf(md?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text);
          const badges = JSON.stringify(v.contentImage || {}).match(/"text":"(\d+(?::\d\d)+)"/);
          add(v.contentId, textOf(md?.title), channel, badges?.[1]);
        } else if (v && typeof v === "object") {
          walk(v);
        }
      }
    };
    walk(data);
    return out;
  }

  async function search(seq, q) {
    q = str(String(q || "").trim(), 200);
    let items = [];
    let error = "";
    if (q) {
      try {
        const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, { credentials: "include" });
        items = parseSearch(await r.text());
      } catch (e) {
        error = String(e?.message || e);
      }
    }
    post({ type: "results", seq, items, error });
  }

  // ------------------------------------------------------------- commands
  async function toTab(msg) {
    if (activeTab == null) return false;
    try {
      await chrome.tabs.sendMessage(activeTab, { fx: "cmd", ...msg });
      return true;
    } catch (_) {
      forgetTab(activeTab);
      return false;
    }
  }

  async function play(ids, index) {
    ids = (Array.isArray(ids) ? ids : []).filter((id) => ID_RE.test(id)).slice(0, 500);
    const id = ids[index] || ids[0];
    if (!id) return;
    if (await toTab({ cmd: "play", id, ids })) return;
    // No Focus tab yet: open one. It picks up the queue with "hello".
    const tab = await chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${id}`, active: true });
    pendingCtx.set(tab.id, { ids });
  }

  async function showBrowser() {
    if (activeTab != null) {
      try {
        const tab = await chrome.tabs.update(activeTab, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return;
      } catch (_) {
        forgetTab(activeTab);
      }
    }
    const tab = await chrome.tabs.create({ url: "https://www.youtube.com/", active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  async function onHostMessage(m) {
    if (!m || typeof m !== "object") return;
    await ready;
    switch (m.type) {
      case "cmd": {
        const c = m.cmd;
        if (["toggle", "next", "prev", "likeCurrent"].includes(c)) toTab({ cmd: c });
        else if (c === "seek" && Number.isFinite(m.t)) toTab({ cmd: c, t: m.t });
        else if (c === "volume" && Number.isFinite(m.v)) toTab({ cmd: c, v: Math.max(0, Math.min(100, Math.round(m.v))) });
        else if (c === "play") play(m.ids, Number(m.index) || 0);
        else if (c === "videoMode" && globalThis.FX.VIDEO_MODES.includes(m.mode)) globalThis.FX.setSetting("videoMode", m.mode);
        else if (c === "focus") globalThis.FX.setSetting("focus", !!m.on);
        else if (c === "showBrowser") showBrowser();
        else if (c === "lib") lib(m.op, m);
        break;
      }
      case "search":
        search(m.seq, m.q);
        break;
      case "getLibrary":
        pushLibrary();
        break;
      case "getState":
        pushState();
        break;
    }
  }

  // ------------------------------------------------------------- wiring
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || typeof msg !== "object") return;
    const tabId = sender.tab?.id;
    if (msg.fx === "state" && tabId != null) {
      onTabState(tabId, msg.state);
      connect();
    } else if (msg.fx === "hello" && tabId != null) {
      const ctx = pendingCtx.get(tabId) || null;
      pendingCtx.delete(tabId);
      reply({ ctx });
      connect();
    } else if (msg.fx === "options") {
      chrome.runtime.openOptionsPage();
    } else if (msg.fx === "desktopStatus") {
      connect().then(() => setTimeout(() => reply({ status, error: lastError, id: chrome.runtime.id }), 400));
      return true;
    } else if (msg.fx === "desktopRetry") {
      connect(true).then(() => setTimeout(() => reply({ status, error: lastError, id: chrome.runtime.id }), 600));
      return true;
    }
  });

  chrome.tabs.onRemoved.addListener(forgetTab);
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url && !/^https:\/\/www\.youtube\.com\//.test(info.url)) forgetTab(tabId);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) {
      const was = !!changes.settings.oldValue?.desktop;
      const now = !!changes.settings.newValue?.desktop;
      if (now && !was) setTimeout(() => connect(true), 0);
      if (!now && was) disconnect("off");
    }
    if (changes.songs || changes.playlists || changes.recent) pushLibrary();
    if (changes.songs || changes.settings) pushState();
  });

  chrome.runtime.onStartup.addListener(() => connect(true));
  chrome.runtime.onInstalled.addListener(() => connect(true));
  connect(true);

  return { parseSearch, status: () => ({ status, error: lastError }) };
})();
