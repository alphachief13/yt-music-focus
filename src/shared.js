/**
 * Focus — shared helpers for the isolated-world content scripts
 * (settings, storage, i18n, title parsing). Exposed as `globalThis.FX`.
 */
(() => {
  "use strict";

  const DEFAULTS = Object.freeze({
    focus: true,       // Focus mode on/off
    autoHide: true,    // fade corners/controls when the mouse rests
    ambient: true,     // faint blurred artwork glow around the video
    adMute: true,      // yt-ads-sucks: mute ads
    adBlackout: true,  // yt-ads-sucks: black screen over ads
    adSkip: true,      // yt-ads-sucks: speed up + auto click "Skip"
    videoMode: "video", // "video" | "cover" (artwork only) | "dark" (nothing)
    desktop: false,    // optional GNOME panel bridge (src/desktop.js)
  });
  const VIDEO_MODES = ["video", "cover", "dark"];
  const normSettings = (s) => {
    const out = { ...DEFAULTS, ...(s && typeof s === "object" ? s : {}) };
    if (!VIDEO_MODES.includes(out.videoMode)) out.videoMode = "video";
    return out;
  };

  // ---------------------------------------------------------------- storage
  const listeners = new Set();
  const cache = { settings: { ...DEFAULTS }, songs: {}, playlists: [], recent: [] };

  function alive() {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  }

  const ready = (async () => {
    if (!alive()) return cache;
    const got = await chrome.storage.local.get(["settings", "songs", "playlists", "recent"]);
    cache.settings = normSettings(got.settings);
    cache.songs = got.songs && typeof got.songs === "object" ? got.songs : {};
    cache.playlists = Array.isArray(got.playlists) ? got.playlists : [];
    cache.recent = Array.isArray(got.recent) ? got.recent : [];
    return cache;
  })().catch(() => cache);

  if (alive()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      for (const [k, { newValue }] of Object.entries(changes)) {
        if (!(k in cache)) continue;
        cache[k] = k === "settings" ? normSettings(newValue) : newValue ?? (k === "songs" ? {} : []);
      }
      listeners.forEach((fn) => fn(changes));
    });
  }

  async function save(patch) {
    Object.assign(cache, patch);
    if (!alive()) return;
    try { await chrome.storage.local.set(patch); } catch (_) { /* context invalidated */ }
  }

  function setSetting(key, value) {
    return save({ settings: { ...cache.settings, [key]: value } });
  }

  // ---------------------------------------------------------------- i18n
  const STRINGS = {
    en: {
      focus: "Focus", search: "Search", library: "Library", liked: "Liked",
      playlists: "Playlists", recent: "Recent", settings: "Settings",
      searchPh: "Search a song", filterPh: "Filter", empty: "Nothing here yet.",
      emptyLiked: "Songs you ♡ appear here.", newPlaylist: "New playlist",
      playlistName: "Playlist name", addCurrent: "Add current song", added: "Added",
      deletePl: "Delete playlist", sure: "Click again to delete", back: "Back",
      continue: "Continue", ad: "Ad", adMuted: "Ad · muted", adSkipping: "Ad · skipping",
      adShow: "Show ad", adHide: "Hide ad", adRunning: "Ad playing",
      adSub: "Muted · it will be skipped as soon as YouTube allows",
      sFocus: "Focus mode", sAutoHide: "Fade controls when idle", sAmbient: "Ambient glow",
      sAdMute: "Mute ads", sAdBlackout: "Black screen over ads", sAdSkip: "Skip ads automatically",
      export: "Export library", import: "Import", clearRecent: "Clear history",
      imported: "Imported", play: "Play", pause: "Pause", prev: "Previous", next: "Next",
      like: "Like", unlike: "Remove from liked", volume: "Volume", mute: "Mute",
      menu: "Menu", close: "Close", remove: "Remove", seek: "Seek",
      nothingToBrowse: "Nothing to browse.", shortcut: "Alt+Shift+F toggles Focus",
      sVideo: "Video", vVideo: "Video", vCover: "Cover only", vDark: "Dark",
      vVideoShort: "Video", vCoverShort: "Cover", vDarkShort: "Dark", vNext: "click for",
      sDesktop: "Desktop panel (GNOME)", on: "on", off: "off",
      reloadPage: "Focus was updated: reload this page (F5)",
      deskOffHint: "Mirrors this player in the GNOME top bar. Optional.",
      deskConnecting: "Connecting…", deskOk: "Connected to the GNOME panel.",
      deskMissing: "Panel not installed. In a terminal: gnome/install.sh (in the Focus folder), then log out and back in.",
    },
    pt: {
      focus: "Focus", search: "Buscar", library: "Biblioteca", liked: "Curtidas",
      playlists: "Playlists", recent: "Recentes", settings: "Ajustes",
      searchPh: "Buscar uma música", filterPh: "Filtrar", empty: "Nada aqui ainda.",
      emptyLiked: "Músicas que você curtir ♡ aparecem aqui.", newPlaylist: "Nova playlist",
      playlistName: "Nome da playlist", addCurrent: "Adicionar a música atual", added: "Adicionada",
      deletePl: "Excluir playlist", sure: "Clique de novo para excluir", back: "Voltar",
      continue: "Continuar", ad: "Anúncio", adMuted: "Anúncio · mudo", adSkipping: "Anúncio · pulando",
      adShow: "Mostrar anúncio", adHide: "Ocultar anúncio", adRunning: "Anúncio em andamento",
      adSub: "Áudio silenciado · será pulado assim que o YouTube permitir",
      sFocus: "Modo Focus", sAutoHide: "Esmaecer controles em repouso", sAmbient: "Brilho ambiente",
      sAdMute: "Silenciar anúncios", sAdBlackout: "Tela preta nos anúncios", sAdSkip: "Pular anúncios sozinho",
      export: "Exportar biblioteca", import: "Importar", clearRecent: "Limpar histórico",
      imported: "Importado", play: "Tocar", pause: "Pausar", prev: "Anterior", next: "Próxima",
      like: "Curtir", unlike: "Remover das curtidas", volume: "Volume", mute: "Mudo",
      menu: "Menu", close: "Fechar", remove: "Remover", seek: "Avançar",
      nothingToBrowse: "Nada para navegar.", shortcut: "Alt+Shift+F liga/desliga o Focus",
      sVideo: "Vídeo", vVideo: "Vídeo ligado", vCover: "Só a capa", vDark: "Escuro",
      vVideoShort: "Vídeo", vCoverShort: "Capa", vDarkShort: "Escuro", vNext: "clique para",
      sDesktop: "Painel do desktop (GNOME)", on: "ligado", off: "desligado",
      reloadPage: "O Focus foi atualizado: recarregue a página (F5)",
      deskOffHint: "Espelha este player no painel superior do GNOME. Opcional.",
      deskConnecting: "Conectando…", deskOk: "Conectado ao painel do GNOME.",
      deskMissing: "Painel não instalado. No terminal: gnome/install.sh (na pasta do Focus), depois saia e entre na sessão.",
    },
  };
  const lang = (navigator.language || "en").toLowerCase().startsWith("pt") ? "pt" : "en";
  const t = (key) => STRINGS[lang][key] ?? STRINGS.en[key] ?? key;

  // ---------------------------------------------------------------- titles
  // "Arctic Monkeys - 505 (Official Video)" -> { title: "505", artist: "Arctic Monkeys" }
  const JUNK =
    /\s*[([{【][^)\]}】]*?\b(official|video|audio|lyrics?|letra|legendado|tradu[çc][ãa]o|visuali[sz]er|clipe?|hd|hq|4k|remaster(ed)?|m\/?v|music)\b[^)\]}】]*[)\]}】]/gi;

  function parseTitle(raw = "", channel = "") {
    let title = String(raw).replace(JUNK, "").replace(/\s*[|｜/]{1,2}\s.*$/, "").trim();
    let artist = String(channel)
      .replace(/\s*-\s*Topic$/i, "")
      .replace(/VEVO$/i, "")
      .replace(/\s*(official)?$/i, "")
      .trim();
    const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) {
      artist = m[1].trim();
      title = m[2].trim();
    }
    title = title.replace(/^["“'‘](.+)["”'’]$/, "$1").replace(/\s+/g, " ").trim() || String(raw).trim();
    return { title, artist };
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  globalThis.FX = {
    DEFAULTS,
    VIDEO_MODES,
    cache,
    ready,
    save,
    setSetting,
    onChange: (fn) => listeners.add(fn),
    t,
    lang,
    parseTitle,
    fmtTime,
    thumbUrl: (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  };
})();
