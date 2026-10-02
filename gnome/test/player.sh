#!/usr/bin/env bash
# Local player (gnome/daemon/main.js) on the real youtube.com, isolated:
# private D-Bus, throwaway data dirs, WebKit muted. Needs a graphical session.
#   gnome/test/player.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export XDG_DATA_HOME="$TMP/data" XDG_CACHE_HOME="$TMP/cache" YTFOCUS_TEST_MUTE=1
mkdir -p "$XDG_DATA_HOME/yt-focus"
cat > "$XDG_DATA_HOME/yt-focus/session.json" <<'J'
{"videoId":"qU9mHegkTc4","title":"505","artist":"Arctic Monkeys","duration":253,"position":60,"playing":true,
 "queue":["qU9mHegkTc4","GCdwKhTtNNw"],"volume":40,"by":"browser"}
J
echo '{"liked":[],"playlists":[{"id":"pl1","name":"late night","tracks":[]}],"recent":[],"settings":{"videoMode":"cover","focus":true}}' \
  > "$XDG_DATA_HOME/yt-focus/library.json"
exec dbus-run-session -- python3 "$ROOT/test/player-check.py" "$ROOT/daemon/main.js" "$XDG_DATA_HOME/yt-focus"
