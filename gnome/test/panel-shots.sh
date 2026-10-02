#!/usr/bin/env bash
# Screenshots of the GNOME panel, rendered by a headless GNOME Shell on a
# private D-Bus with throwaway XDG dirs (your session and settings are not
# touched). Output: gnome/test/shots/panel-*.png
#   gnome/test/panel-shots.sh           # panel mirroring a (fake) browser
#   gnome/test/panel-shots.sh --local   # no browser: panel starts the local player
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
OUT="$ROOT/test/shots"
mkdir -p "$OUT" "$TMP/data" "$TMP/config/glib-2.0/settings" "$TMP/cache" "$TMP/runtime"
chmod 700 "$TMP/runtime"
trap 'rm -rf "$TMP"' EXIT

export XDG_DATA_HOME="$TMP/data" XDG_CONFIG_HOME="$TMP/config" XDG_CACHE_HOME="$TMP/cache"
export GSETTINGS_BACKEND=keyfile YTFOCUS_NO_ENABLE=1 YTF_SNAP_DIR="$OUT"

cat > "$TMP/config/glib-2.0/settings/keyfile" <<'EOF'
[org/gnome/shell]
enabled-extensions=['yt-focus@alphachief13', 'snap@ytf-test']
disable-user-extensions=false
welcome-dialog-last-shown-version='999'

[org/gnome/desktop/interface]
color-scheme='prefer-dark'
EOF

"$ROOT/install.sh" >/dev/null
cp -r "$ROOT/test/snap@ytf-test" "$XDG_DATA_HOME/gnome-shell/extensions/"

if [[ "${1:-}" == "--local" ]]; then
  # No browser at all: the panel starts the local player (muted) by itself.
  export YTF_SNAP_MODE=local YTFOCUS_TEST_MUTE=1
  echo '{"videoId":"qU9mHegkTc4","title":"505","artist":"Arctic Monkeys","duration":253,"position":95,"queue":[],"volume":60}' \
    > "$XDG_DATA_HOME/yt-focus/session.json"
  echo '{"liked":[{"videoId":"qU9mHegkTc4","title":"505","artist":"Arctic Monkeys","duration":253},{"videoId":"GCdwKhTtNNw","title":"Sweater Weather","artist":"The Neighbourhood","duration":240}],"playlists":[],"recent":[],"settings":{"videoMode":"video","focus":true}}' \
    > "$XDG_DATA_HOME/yt-focus/library.json"
  dbus-run-session -- timeout 130 gnome-shell --headless --wayland --no-x11 --wayland-display=wayland-ytf-test \
    --virtual-monitor 1440x900 > "$TMP/shell.log" 2>&1 || true
  grep -E "ytf-snap|JS ERROR" "$TMP/shell.log" | head
  exit 0
fi

dbus-run-session -- bash -c '
  python3 "$1/test/fake-browser.py" "$XDG_DATA_HOME/yt-focus/host/focus-host.js" > "$2/fake.log" 2>&1 &
  timeout 40 gnome-shell --headless --wayland --no-x11 --wayland-display=wayland-ytf-test \
    --virtual-monitor 1440x900 > "$2/shell.log" 2>&1 || true
  kill %1 2>/dev/null || true
' _ "$ROOT" "$TMP"

grep -E "ytf-snap|yt-focus|JS ERROR|Error" "$TMP/shell.log" | grep -v "libva\|dbus-daemon" | head -20 || true
grep "cmd:" "$TMP/fake.log" | head -5 || true
ls "$OUT"
