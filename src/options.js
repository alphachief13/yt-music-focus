/**
 * Focus — options page (same switch as Settings → Desktop panel, plus the
 * install command). Flips settings.desktop; desktop.js connects to the host.
 */
"use strict";
(() => {
  const FX = globalThis.FX;
  const pt = FX.lang === "pt";
  const T = pt
    ? {
        title: "Painel do desktop", sub: "Mostra e controla o Focus pelo painel do GNOME. Opcional: sem isso, o Focus funciona igual.",
        setup: "Instale o painel uma vez (Linux com GNOME 48–49), depois clique em “Tentar de novo”:",
        copy: "Copiar comando", copied: "Copiado", retry: "Tentar de novo",
        foot: "O áudio continua vindo da aba do YouTube; o painel só espelha e controla o Focus.",
        off: "Desligado.", connecting: "Conectando…", connected: "Conectado ao painel do GNOME.",
        noPerm: "Permissão negada pelo navegador.", missing: "O painel ainda não está instalado neste computador.",
      }
    : {
        title: "Desktop panel", sub: "Shows and controls Focus from the GNOME top bar. Optional: Focus works the same without it.",
        setup: "Install the panel once (Linux with GNOME 48–49), then click “Try again”:",
        copy: "Copy command", copied: "Copied", retry: "Try again",
        foot: "Audio still comes from the YouTube tab; the panel only mirrors and controls Focus.",
        off: "Off.", connecting: "Connecting…", connected: "Connected to the GNOME panel.",
        noPerm: "The browser denied the permission.", missing: "The panel isn't installed on this computer yet.",
      };
  document.documentElement.lang = FX.lang;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = T[el.dataset.i18n] ?? el.textContent;

  const $ = (id) => document.getElementById(id);
  const toggle = $("toggle");
  const status = $("status");
  const setup = $("setup");
  $("cmd").textContent = `./gnome/install.sh ${chrome.runtime.id}`;

  function show(kind, detail = "") {
    status.replaceChildren();
    const span = document.createElement("span");
    if (kind === "connected") span.className = "ok";
    span.textContent = { off: T.off, connecting: T.connecting, connected: T.connected, "no-permission": T.noPerm, error: T.missing }[kind] || "";
    status.append(span);
    if (detail && kind === "error") {
      const small = document.createElement("div");
      small.style.cssText = "margin-top:4px;font-size:13px;color:var(--faint)";
      small.textContent = detail;
      status.append(small);
    }
    setup.hidden = kind !== "error";
  }

  const ask = (fx) => chrome.runtime.sendMessage({ fx }).catch(() => null);

  async function refresh(fx = "desktopStatus") {
    await FX.ready;
    const on = !!FX.cache.settings.desktop;
    toggle.setAttribute("aria-checked", String(on));
    if (!on) return show("off");
    show("connecting");
    const r = await ask(fx);
    show(r?.status || "error", r?.error);
  }

  toggle.addEventListener("click", async () => {
    const on = toggle.getAttribute("aria-checked") !== "true";
    await FX.setSetting("desktop", on);
    setTimeout(() => refresh("desktopRetry"), 200);
  });

  $("retry").addEventListener("click", () => refresh("desktopRetry"));
  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("cmd").textContent);
      $("copy").textContent = T.copied;
      setTimeout(() => ($("copy").textContent = T.copy), 1500);
    } catch (_) { /* clipboard blocked */ }
  });

  refresh();
})();
