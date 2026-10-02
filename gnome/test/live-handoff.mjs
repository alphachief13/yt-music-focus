// Hand-off between the browser and the local player, on the real youtube.com:
//   1. Focus tab plays            -> panel backend "browser"
//   2. Chrome closes mid-song      -> local player carries on (same song/time)
//   3. like it without the browser -> kept in pending.json
//   4. Chrome opens, no Focus tab  -> local player keeps playing
//   5. a Focus tab plays           -> browser takes the panel back, player
//                                     exits, the like reaches chrome.storage
// Isolated: private D-Bus, throwaway profile and data dirs, all audio muted.
//   dbus-run-session -- node gnome/test/live-handoff.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../..");
const VID = "qU9mHegkTc4";
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const work = mkdtempSync(join(tmpdir(), "fx-handoff-"));
const env = {
  ...process.env,
  XDG_DATA_HOME: join(work, "data"), XDG_CONFIG_HOME: join(work, "config"), XDG_CACHE_HOME: join(work, "cache"),
  YTFOCUS_NO_ENABLE: "1", YTFOCUS_TEST_MUTE: "1",
};
execFileSync(join(REPO, "gnome/install.sh"), [], { env, stdio: "ignore" });
const DATA = join(env.XDG_DATA_HOME, "yt-focus");
check("installer put the local player in place", existsSync(join(DATA, "daemon/main.js")) && existsSync(join(DATA, "daemon/page/ads.js")));

const profile = join(work, "profile");
const extId = execFileSync("bash", ["-c", `printf '%s' "$1" | sha256sum | cut -c1-32 | tr '0-9a-f' 'a-p'`, "_", REPO]).toString().trim();
mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
writeFileSync(join(profile, "NativeMessagingHosts", "io.github.alphachief13.focus.json"),
  readFileSync(join(env.XDG_CONFIG_HOME, "google-chrome/NativeMessagingHosts/io.github.alphachief13.focus.json")));

const dbus = (method, ...args) => {
  try {
    return execFileSync("gdbus", ["call", "--session", "-d", "io.github.alphachief13.YtFocus", "-o", "/io/github/alphachief13/YtFocus",
      "-m", `io.github.alphachief13.YtFocus.${method}`, ...args], { timeout: 25000 }).toString().trim();
  } catch (e) {
    return `ERROR ${e.stderr?.toString().trim() || e.message}`;
  }
};
const json = (out) => {
  const m = out.match(/^\('(.*)',\)$/s);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\")); } catch { return null; }
};
const state = () => json(dbus("GetState")) || {};
const playerRunning = () => {
  try { return execFileSync("pgrep", ["-f", `${DATA}/daemon/main.js`]).toString().trim().length > 0; } catch { return false; }
};
async function waitFor(pred, secs) {
  let s = {};
  for (let i = 0; i < secs * 2; i++) {
    s = state();
    if (pred(s)) return s;
    await sleep(500);
  }
  return s;
}

// ------------------------------------------------------------------ Chrome
let chrome = null, ws = null, seq = 0;
const pending = new Map();
const cmd = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

async function startChrome() {
  chrome = spawn(process.env.CHROME || "google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--enable-unsafe-extension-debugging", "--remote-allow-origins=*", "--mute-audio",
    "--window-size=1440,900", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "about:blank",
  ], { stdio: "ignore", env });
  let ver;
  for (let i = 0; i < 60 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
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
  const { id } = await cmd("Extensions.loadUnpacked", { path: REPO });
  await sleep(1500);
  const { targetInfos } = await cmd("Target.getTargets");
  const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(id));
  const { sessionId } = await cmd("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
  return async (expr) => (await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
}

async function openWatch() {
  const { targetId } = await cmd("Target.createTarget", { url: `https://www.youtube.com/watch?v=${VID}` });
  await cmd("Target.attachToTarget", { targetId, flatten: true });
}

async function closeChrome() {
  try { await cmd("Browser.close"); } catch {}
  try { ws.close(); } catch {}
  await new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once("exit", r)));
}

try {
  // 1. the browser plays
  let sw = await startChrome();
  check("extension ID matches the installer", (await sw("chrome.runtime.id")) === extId);
  await sw(`chrome.storage.local.get("settings").then(({settings = {}}) => chrome.storage.local.set({ settings: { ...settings, desktop: true } }))`);
  await sleep(2000);
  await openWatch();
  let s = await waitFor((s) => s.track?.videoId === VID && s.status === "playing" && s.position >= 8, 60);
  check("Focus tab plays, panel on the browser", s.backend === "browser" && s.status === "playing", `${s.backend} ${s.status} ${s.position}s`);
  const before = s.position;

  // 2. close the browser mid-song
  await closeChrome();
  s = await waitFor((s) => s.backend === "local" && s.status === "playing" && s.position > 0, 90);
  check("browser closed: local player carries on", s.backend === "local" && s.track?.videoId === VID && s.status === "playing",
    `${s.backend} ${s.track?.videoId} ${s.status}`);
  check("…from about the same point", s.position >= before - 2 && s.position < before + 60, `${Math.round(before)}s -> ${Math.round(s.position)}s`);

  // 3. edit without the browser
  dbus("ToggleLikeCurrent");
  await sleep(800);
  check("like without the browser", state().liked === true);
  const pend = JSON.parse(readFileSync(join(DATA, "pending.json"), "utf8"));
  check("…kept for the browser", pend.some((o) => o.op === "like" && o.track?.videoId === VID), pend.map((o) => o.op).join(","));

  // 4. browser opens again, nothing playing in it
  sw = await startChrome();
  await sleep(6000);
  s = state();
  check("browser opened without playing: local player keeps the music", s.backend === "local" && ["playing", "ad"].includes(s.status) && playerRunning(),
    `${s.backend} ${s.status}`);

  // 5. a Focus tab plays: browser takes over
  await openWatch();
  s = await waitFor((s) => s.backend === "browser" && s.status === "playing", 60);
  check("Focus tab plays: panel back on the browser", s.backend === "browser" && s.status === "playing", `${s.backend} ${s.status}`);
  await sleep(4000);
  check("local player exited (no double audio)", !playerRunning());
  const liked = await sw(`chrome.storage.local.get("songs").then(({songs = {}}) => !!songs["${VID}"]?.liked)`);
  check("like made without the browser reached chrome.storage", liked === true);
  check("pending edits cleared", !existsSync(join(DATA, "pending.json")));
  await closeChrome();
} catch (e) {
  failures++;
  console.error("test crashed:", e.stack || e.message);
} finally {
  try { chrome?.kill(); } catch {}
  dbus("Quit");
  await sleep(1500);
  try { execFileSync("pkill", ["-f", `${DATA}/daemon/main.js`]); } catch {}
  rmSync(work, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
  process.exitCode = failures ? 1 : 0;
}
