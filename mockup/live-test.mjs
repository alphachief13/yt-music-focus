// Live smoke test: loads the unpacked extension in Chrome, opens a real
// YouTube watch page and reports what Focus did. Usage:
//   node mockup/live-test.mjs [videoId]   -> mockup/shots/live-*.png
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const VID = process.argv[2] || "qU9mHegkTc4";
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), "fx-live-"));
const chrome = spawn(process.env.CHROME || "google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--enable-unsafe-extension-debugging", "--remote-allow-origins=*",
  "--window-size=1440,900", "--autoplay-policy=no-user-gesture-required",
  "--no-first-run", "--lang=en-US", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map();
const cmd = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

try {
  let ver;
  for (let i = 0; i < 50 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); }
  }
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  };

  const { id: extId } = await cmd("Extensions.loadUnpacked", { path: ROOT });
  console.log("loaded extension:", extId);
  await sleep(800);
  const { targetInfos } = await cmd("Target.getTargets");
  const exts = targetInfos.filter((t) => t.url.startsWith("chrome-extension://"));
  console.log("extension targets:", exts.map((t) => `${t.type} ${t.url}`).join(", ") || "none");

  const { targetId } = await cmd("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cmd("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => cmd(m, p, sessionId);
  await s("Page.enable");
  await s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await s("Page.navigate", { url: `https://www.youtube.com/watch?v=${VID}` });
  await sleep(12000);

  const evalJs = async (expr) => (await s("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  // Consent wall (EU) — click "Accept all" if present.
  await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(b => /accept all|aceitar tudo/i.test(b.textContent)); b?.click(); return !!b; })()`);
  await sleep(4000);

  const report = await evalJs(`(() => {
    const q = (s) => document.querySelector(s);
    const r = (s) => { const b = q(s)?.getBoundingClientRect(); return b ? [b.left, b.top, b.width, b.height].map(Math.round).join(",") : null; };
    const vis = (s) => { const e = q(s); return e ? getComputedStyle(e).visibility + "/" + getComputedStyle(e).display : null; };
    const v = q("video.html5-main-video");
    return {
      url: location.href,
      htmlClass: document.documentElement.className,
      ui: !!q("#fx-ui"),
      title: q(".fx-title")?.textContent, artist: q(".fx-artist")?.textContent,
      times: q(".fx-times")?.textContent,
      player: r("#movie_player"), stage: r(".fx-stage"),
      ytdApp: vis("ytd-app"), secondary: vis("ytd-watch-flexy #secondary"), comments: vis("ytd-comments"), masthead: vis("#masthead-container"),
      video: v ? { paused: v.paused, t: Math.round(v.currentTime), d: Math.round(v.duration), muted: v.muted } : null,
      ad: q("#movie_player")?.classList.contains("ad-showing"),
      adUi: !!q(".ytas-blackout"),
    };
  })()`);
  console.log(JSON.stringify(report, null, 2));
  const shot = async (name) => {
    const { data } = await s("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(ROOT, "mockup/shots", `live-${name}.png`), Buffer.from(data, "base64"));
    console.log(`mockup/shots/live-${name}.png`);
  };
  await shot("watch");

  // Exercise controls through our own UI.
  await evalJs(`document.querySelector(".fx-play").click()`);
  await sleep(1500);
  const afterToggle = await evalJs(`(() => { const v = document.querySelector("video.html5-main-video"); return { paused: v?.paused, label: document.querySelector(".fx-play")?.getAttribute("aria-label") }; })()`);
  console.log("after play/pause click:", JSON.stringify(afterToggle));
  await evalJs(`document.querySelector(".fx-heart").click()`);
  await sleep(500);
  const liked = await evalJs(`document.querySelector(".fx-heart").getAttribute("aria-pressed")`);
  console.log("liked:", liked);

  // Video off: cycle video -> cover -> dark -> video through our button.
  await evalJs(`document.querySelector(".fx-play").click()`); // resume playback
  const vstate = `(() => {
    const p = document.getElementById("movie_player"), v = p.querySelector("video"), img = document.querySelector("#fx-cover img");
    return { cls: ["fx-vcover", "fx-vdark"].filter((c) => document.documentElement.classList.contains(c)).join(",") || "video",
      cover: getComputedStyle(document.getElementById("fx-cover")).display, coverImg: img.naturalWidth + "px " + img.src.split("/").pop(),
      videoOpacity: getComputedStyle(v).opacity, quality: p.getPlaybackQuality(), playing: !v.paused,
      btn: document.querySelector(".fx-vmode").getAttribute("aria-label") };
  })()`;
  for (const step of ["cover", "dark", "video"]) {
    await evalJs(`document.querySelector(".fx-vmode").click()`);
    await sleep(6000);
    console.log(`mode ${step}:`, JSON.stringify(await evalJs(vstate)));
    if (step !== "video") {
      await s("Input.dispatchMouseEvent", { type: "mouseMoved", x: 720, y: 640 });
      await sleep(400);
      await shot(step);
    }
  }
  await s("Input.dispatchMouseEvent", { type: "mouseMoved", x: 720, y: 640 });
  await sleep(600);
  await shot("paused");

  // Search through our own field: YouTube's /results page, scraped to text rows.
  await evalJs(`(() => { const i = document.querySelector(".fx-search .fx-input"); i.value = "radiohead weird fishes"; i.form.requestSubmit(); })()`);
  await evalJs(`(() => { document.querySelector(".fx-menu-btn").click(); [...document.querySelectorAll(".fx-menu button")][0].click(); })()`);
  await sleep(1500);
  await evalJs(`(() => { const i = document.querySelector(".fx-search .fx-input"); i.value = "radiohead weird fishes"; i.form.requestSubmit(); })()`);
  await sleep(8000);
  const res = await evalJs(`(() => ({
    url: location.pathname + location.search,
    htmlClass: document.documentElement.className,
    rows: [...document.querySelectorAll(".fx-results-list .fx-row")].map(r => r.innerText.replace(/\\n/g, " · ")).slice(0, 6),
    now: document.querySelector(".fx-now")?.classList.contains("is-on"),
  }))()`);
  console.log("search:", JSON.stringify(res, null, 2));
  await s("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 300 });
  await shot("results");

  // Play the first result from our list.
  await evalJs(`document.querySelector(".fx-results-list .fx-row-text")?.click()`);
  await sleep(7000);
  const after = await evalJs(`({ url: location.pathname + location.search, title: document.querySelector(".fx-title")?.textContent, artist: document.querySelector(".fx-artist")?.textContent, cls: document.documentElement.className })`);
  console.log("played result:", JSON.stringify(after));
  // If an ad is playing, follow it: did yt-ads-sucks' auto-skip get it?
  for (let i = 0; i < 20; i++) {
    const a = await evalJs(`(() => {
      const p = document.getElementById("movie_player"); const v = p?.querySelector("video");
      const skip = [...p.querySelectorAll("button")].filter((b) => /skip|pular/i.test(b.className + b.textContent)).map((b) => b.className.split(" ")[0] + (b.offsetParent ? "+" : "-"));
      return { ad: p?.classList.contains("ad-showing"), muted: v?.muted, rate: v?.playbackRate, skip: skip.join(" "), t: Math.round(v?.currentTime || 0) };
    })()`);
    if (!a.ad && i > 0) { console.log(`ad over after ~${i * 0.5}s`, JSON.stringify(a)); break; }
    if (a.ad) console.log("ad:", JSON.stringify(a));
    else { console.log("no ad"); break; }
    await sleep(500);
  }
  await s("Input.dispatchMouseEvent", { type: "mouseMoved", x: 720, y: 600 });
  await sleep(400);
  await shot("next");
} catch (e) {
  console.error("live test failed:", e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
