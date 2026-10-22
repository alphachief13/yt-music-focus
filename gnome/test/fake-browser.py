#!/usr/bin/env python3
"""Plays the browser side of native messaging for tests: starts the real
focus-host.js and feeds it a fixed state and library (and answers searches),
so the GNOME panel can be exercised without Chrome. Runs until killed."""
import json, struct, subprocess, sys, threading, time

host = sys.argv[1]
p = subprocess.Popen([host, "chrome-extension://test/"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
lock = threading.Lock()

def send(m):
    b = json.dumps(m).encode()
    with lock:
        p.stdin.write(struct.pack("<I", len(b)) + b)
        p.stdin.flush()

T = lambda v, t, a, d: {"videoId": v, "title": t, "artist": a, "duration": d}
SONGS = [
    T("qU9mHegkTc4", "505", "Arctic Monkeys", 253),
    T("GCdwKhTtNNw", "Sweater Weather", "The Neighbourhood", 240),
    T("bpOSxM0rNPM", "Do I Wanna Know?", "Arctic Monkeys", 272),
    T("uzS3WG6__G4", "Pink + White", "Frank Ocean", 184),
    T("TNRCvG9YtYI", "Weird Fishes", "Radiohead", 318),
]
state = {"id": "qU9mHegkTc4", "title": "505", "artist": "Arctic Monkeys", "duration": 253, "position": 102,
         "playing": True, "ad": False, "volume": 64, "muted": False, "liked": True, "videoMode": "cover", "focus": True}
library = {"liked": SONGS[:4], "playlists": [
    {"id": "pl1", "name": "late night", "tracks": [SONGS[0], SONGS[4], SONGS[1]]},
    {"id": "pl2", "name": "deep work", "tracks": [SONGS[3]]},
], "recent": [SONGS[0], SONGS[4], SONGS[2], SONGS[1]]}

def reader():
    while True:
        h = p.stdout.read(4)
        if len(h) < 4:
            return
        m = json.loads(p.stdout.read(struct.unpack("<I", h)[0]))
        print("cmd:", m, flush=True)
        if m.get("type") == "search":
            send({"type": "results", "seq": m["seq"], "items": [SONGS[2], SONGS[0], SONGS[1]]})
        elif m.get("cmd") == "toggle":
            state["playing"] = not state["playing"]
            send({"type": "state", "state": state})
        elif m.get("cmd") == "skipAd" and ad.get("skippable"):
            ad.clear()
            send({"type": "state", "state": shown()})

# An ad from AD_AT seconds on: the tab then reports the ad's own <video>
# (position/duration), and "Skip" unlocks after AD_SKIP_AFTER seconds.
AD_AT, AD_LEN, AD_SKIP_AFTER = 16, 30, 3
ad = {}

def shown():
    if not ad:
        return state
    return {**state, "ad": True, "position": ad["pos"], "duration": AD_LEN, "adSkippable": ad["skippable"]}

threading.Thread(target=reader, daemon=True).start()
send({"type": "hello", "version": "test"})
send({"type": "library", "library": library})
start = time.time()
ad_done = False
while True:
    if not ad and not ad_done and time.time() - start >= AD_AT:
        ad.update(pos=0, skippable=False)
    send({"type": "state", "state": shown()})
    time.sleep(1)
    if ad:
        ad_done = True
        ad["pos"] = min(AD_LEN, ad["pos"] + 1)
        ad["skippable"] = ad["pos"] >= AD_SKIP_AFTER
    elif state["playing"]:
        state["position"] = min(state["duration"], state["position"] + 1)
