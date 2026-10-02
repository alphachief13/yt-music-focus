// End-to-end test of the desktop bridge, on the real youtube.com:
//   Chrome (Focus loaded) ⇄ native host ⇄ D-Bus  — checked with gdbus.
//
// Runs on a private D-Bus and a throwaway Chrome profile, so nothing touches
// your session or browser:
//   dbus-run-session -- node gnome/test/live-desktop.mjs
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../..");
const VID = "qU9mHegkTc4";
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- a copy of the extension where nativeMessaging is already granted ------
// (the optional-permission prompt can't be clicked in headless Chrome)
const work = mkdtempSync(join(tmpdir(), "fx-desk-"));
const ext = join(work, "ext");
cpSync(REPO, ext, { recursive: true, filter: (p) => !/\/(\.git|mockup\/shots|node_modules)(\/|$)/.test(p) });
const mf = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
mf.permissions = [...new Set([...mf.permissions, "nativeMessaging"])];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(mf, null, 2));

// --- native host, installed into the throwaway profile ---------------------
const profile = join(work, "profile");
const hostDir = join(work, "host");
mkdirSync(hostDir, { recursive: true });
cpSync(join(REPO, "gnome/host/focus-host.js"), join(hostDir, "focus-host.js"));
cpSync(join(REPO, "gnome/common/iface.js"), join(hostDir, "iface.js"));
chmodSync(join(hostDir, "focus-host.js"), 0o755);
const extId = execFileSync("bash", ["-c", `printf '%s' "$1" | sha256sum | cut -c1-32 | tr '0-9a-f' 'a-p'`, "_", ext]).toString().trim();
mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
writeFileSync(join(profile, "NativeMessagingHosts", "io.github.alphachief13.focus.json"), JSON.stringify({
  name: "io.github.alphachief13.focus", description: "test", path: join(hostDir, "focus-host.js"),
  type: "stdio", allowed_origins: [`chrome-extension://${extId}/`],
}));

const chrome = spawn(process.env.CHROME || "google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--enable-unsafe-extension-debugging", "--remote-allow-origins=*",
  "--window-size=1440,900", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let chromeLog = "";
chrome.stderr.on("data", (d) => (chromeLog += d));

const dbus = (method, ...args) => {
  try {
    return execFileSync("gdbus", ["call", "--session", "-d", "io.github.alphachief13.YtFocus", "-o", "/io/github/alphachief13/YtFocus",
      "-m", `io.github.alphachief13.YtFocus.${method}`, ...args], { timeout: 25000 }).toString().trim();
  } catch (e) {
    return `ERROR ${e.stderr?.toString().trim() || e.message}`;
  }
};
// gdbus prints ('json',) — unwrap the GVariant string.
const json = (out) => {
  const m = out.match(/^\('(.*)',\)$/s);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\")); } catch { return null; }
};

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
  const { id: loadedId } = await cmd("Extensions.loadUnpacked", { path: ext });
  check("extension ID matches install.sh formula", loadedId === extId, `${loadedId} vs ${extId}`);
  await sleep(1000);

  // Before enabling: no host, nothing on D-Bus (the bridge is opt-in).
  check("bridge is off by default", dbus("GetState").startsWith("ERROR"));

  // Enable the setting from the service worker (what the options page does).
  const { targetInfos } = await cmd("Target.getTargets");
  const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(extId));
  const { sessionId: swSession } = await cmd("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
  const swEval = async (expr) => (await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, swSession)).result.value;
  await swEval(`chrome.storage.local.get("settings").then(({settings = {}}) => chrome.storage.local.set({ settings: { ...settings, desktop: true } }))`);
  await sleep(2500);
  const st0 = json(dbus("GetState"));
  check("host started and owns the D-Bus name", !!st0?.connected, JSON.stringify(st0));

  // Open a watch page.
  const { targetId } = await cmd("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cmd("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => cmd(m, p, sessionId);
  await s("Page.enable");
  await s("Page.navigate", { url: `https://www.youtube.com/watch?v=${VID}` });
  const page = async (expr) => (await s("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  let st = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    st = json(dbus("GetState"));
    if (st?.track?.videoId === VID && st.status === "playing") break;
  }
  check("panel state mirrors the tab", st?.track?.videoId === VID && st.track.title === "505" && st.track.artist === "Arctic Monkeys", JSON.stringify(st));
  check("cover cached for the panel", !!st?.track?.thumbFile, st?.track?.thumbFile);

  // Commands from the panel reach the YouTube player.
  dbus("Toggle");
  await sleep(1500);
  check("Toggle pauses the video", await page(`document.querySelector("video.html5-main-video").paused`) === true);
  check("state reports paused", json(dbus("GetState"))?.status === "paused");
  dbus("Toggle");
  await sleep(1500);
  check("Toggle resumes", await page(`!document.querySelector("video.html5-main-video").paused`) === true);

  dbus("Seek", "120");
  await sleep(1500);
  const t = await page(`Math.round(document.querySelector("video.html5-main-video").currentTime)`);
  check("Seek moves the player", t >= 119 && t < 130, `t=${t}`);

  dbus("SetVolume", "35");
  await sleep(1200);
  check("SetVolume reaches the player", json(dbus("GetState"))?.volume === 35);

  dbus("SetVideoMode", "cover");
  await sleep(1200);
  check("SetVideoMode switches the tab to cover", await page(`document.documentElement.classList.contains("fx-vcover")`) === true);
  dbus("SetVideoMode", "video");

  dbus("ToggleLikeCurrent");
  await sleep(1200);
  const liked = json(dbus("GetState"))?.liked;
  const lib = json(dbus("GetLibrary"));
  check("ToggleLikeCurrent likes the song", liked === true && lib?.liked?.some((x) => x.videoId === VID), `liked=${liked}`);
  check("heart in the tab follows", await page(`document.querySelector(".fx-heart").getAttribute("aria-pressed")`) === "true");

  const created = dbus("CreatePlaylist", "from the panel");
  const plId = created.match(/\('([^']+)',\)/)?.[1];
  dbus("AddToPlaylist", plId, JSON.stringify({ videoId: VID, title: "505", artist: "Arctic Monkeys" }));
  await sleep(1200);
  const pl = json(dbus("GetLibrary"))?.playlists?.find((p) => p.id === plId);
  check("playlist created and filled from the panel", pl?.name === "from the panel" && pl.tracks[0]?.videoId === VID);

  const results = json(dbus("Search", "radiohead weird fishes"));
  check("Search returns real results", Array.isArray(results) && results.length >= 5, results?.slice(0, 3).map((r) => `${r.title} — ${r.artist}`).join(" | "));
  check("results have durations and covers", results?.every((r) => r.duration > 0) && results.some((r) => r.thumbFile));

  // Play a result as a queue: the tab navigates.
  const ids = results.slice(0, 3).map((r) => r.videoId);
  dbus("Play", JSON.stringify(ids), "0");
  let url = "";
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    url = await page("location.search");
    if (url.includes(ids[0])) break;
  }
  check("Play navigates the Focus tab", url.includes(ids[0]), url);
  dbus("Next");
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    url = await page("location.search");
    if (url.includes(ids[1])) break;
  }
  check("Next follows the panel's queue", url.includes(ids[1]), url);

  // The in-page switch (☰ → Ajustes) reports the connection.
  await page(`document.querySelector(".fx-menu-btn").click(); [...document.querySelectorAll(".fx-menu button")].find((b) => /Settings|Ajustes/.test(b.textContent)).click(); 1`);
  await sleep(2500);
  const desk = await page(`(() => { const r = [...document.querySelectorAll(".fx-switch-row")].find((b) => /GNOME/.test(b.textContent)); return r.getAttribute("aria-checked") + " | " + document.querySelector(".fx-desk-status").textContent; })()`);
  check("Settings shows the panel switch on and connected", /^true \| (Connected|Conectado)/.test(desk), desk);

  // Turning the setting off (from the same switch) stops the host.
  await page(`[...document.querySelectorAll(".fx-switch-row")].find((b) => /GNOME/.test(b.textContent)).click(); 1`);
  await sleep(2000);
  check("switching it off in Settings stops the host", dbus("GetState").startsWith("ERROR"));


} catch (e) {
  failures++;
  console.error("test crashed:", e.message);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(600);
  rmSync(work, { recursive: true, force: true });
  if (failures && /native/i.test(chromeLog)) console.log(chromeLog.split("\n").filter((l) => /native/i.test(l)).slice(-5).join("\n"));
  console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
  process.exitCode = failures ? 1 : 0;
}
