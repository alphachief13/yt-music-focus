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

threading.Thread(target=reader, daemon=True).start()
send({"type": "hello", "version": "test"})
send({"type": "library", "library": library})
while True:
    send({"type": "state", "state": state})
    time.sleep(1)
    if state["playing"]:
        state["position"] = min(state["duration"], state["position"] + 1)
