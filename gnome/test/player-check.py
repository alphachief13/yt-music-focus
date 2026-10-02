import json, subprocess, sys, time
player, data = sys.argv[1], sys.argv[2]
log = open(data + "/player.log", "w")
p = subprocess.Popen(["gjs", "-m", player, "--resume"], stdout=log, stderr=log)
D = ["gdbus", "call", "--session", "-d", "io.github.alphachief13.YtFocus", "-o", "/io/github/alphachief13/YtFocus", "-m"]
fails = 0
def call(m, *a):
    r = subprocess.run(D + ["io.github.alphachief13.YtFocus." + m, *a], capture_output=True, text=True, timeout=30)
    return r.stdout.strip() if r.returncode == 0 else "ERROR " + r.stderr.strip()
def js(out):
    try:
        return json.loads(out[2:-3].encode().decode("unicode_escape").encode("latin1").decode("utf-8"))
    except Exception:
        return None
def state(): return js(call("GetState")) or {}
def check(name, ok, detail=""):
    global fails
    fails += 0 if ok else 1
    print(("ok  " if ok else "FAIL"), name, ("— " + str(detail)) if detail else "", flush=True)
def wait(pred, secs=90):
    s = {}
    for _ in range(secs * 2):
        s = state()
        if pred(s): return s
        time.sleep(0.5)
    return s

s = wait(lambda s: s.get("status") == "playing" and s.get("position", 0) > 60)
check("resumes the session: same song, from 1:00, playing", s.get("track", {}).get("videoId") == "qU9mHegkTc4" and s.get("backend") == "local",
      {k: s.get(k) for k in ("status", "position", "length", "backend")})
time.sleep(4)
s2 = state()
check("position advances", s2.get("position", 0) > s.get("position", 0) + 2, (s.get("position"), s2.get("position")))
check("title from the page", s2.get("track", {}).get("title") == "505", s2.get("track"))
call("Toggle"); time.sleep(2)
check("Toggle pauses", state().get("status") == "paused")
call("Toggle")
check("Toggle resumes", wait(lambda s: s.get("status") == "playing", 60).get("status") == "playing")
call("Seek", "150"); time.sleep(3)
pos = state().get("position", 0)
check("Seek", 149 <= pos < 160, pos)
call("SetVolume", "25"); time.sleep(1)
check("SetVolume", state().get("volume") == 25)
call("ToggleLikeCurrent"); time.sleep(0.5)
check("like without the browser", state().get("liked") is True)
pend = json.load(open(data + "/pending.json"))
check("edit queued for the browser (pending.json)", any(o.get("op") == "like" for o in pend), [o["op"] for o in pend])
call("Next")
s = wait(lambda s: s.get("track", {}).get("videoId") == "GCdwKhTtNNw" and s.get("status") == "playing", 90)
check("Next follows the queue from the browser", s.get("track", {}).get("videoId") == "GCdwKhTtNNw", s.get("track"))
res = js(call("Search", "radiohead weird fishes")) or []
check("search without the browser", len(res) >= 5 and all(r.get("duration", 0) > 0 for r in res), [r["title"] + " — " + r["artist"] for r in res[:3]])
call("Play", json.dumps([res[0]["videoId"]]), "0")
s = wait(lambda s: s.get("track", {}).get("videoId") == res[0]["videoId"] and s.get("status") == "playing", 90)
check("plays a search result", s.get("status") == "playing", s.get("track"))
call("Quit"); time.sleep(2)
sess = json.load(open(data + "/session.json"))
check("session saved on exit", sess.get("videoId") == res[0]["videoId"] and sess.get("by") == "local", {k: sess.get(k) for k in ("videoId", "position", "by")})
check("player exited", p.poll() is not None)
if p.poll() is None: p.kill()
print("\nall passed" if not fails else f"\n{fails} failure(s)")
if fails:
    print(open(data + "/player.log").read()[-2000:])
sys.exit(1 if fails else 0)
