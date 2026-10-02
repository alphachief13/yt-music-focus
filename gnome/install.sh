#!/usr/bin/env bash
# Focus — installs the optional GNOME panel:
#   1. the native messaging host (lets the browser extension talk to D-Bus)
#   2. the GNOME Shell extension (the panel itself)
#
#   3. the local player, which keeps the music going with the browser closed
#      (needs WebKitGTK 6; skipped if missing — the panel then only mirrors)
#
# Usage:
#   gnome/install.sh [EXTENSION_ID ...]   # default: ID of this folder loaded unpacked
#   gnome/install.sh --uninstall
#
# Nothing here is required by the Chrome extension: Focus works without it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
UUID="yt-focus@alphachief13"
HOST_NAME="io.github.alphachief13.focus"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
APP_DIR="$DATA/yt-focus"
HOST_DIR="$APP_DIR/host"
EXT_DIR="$DATA/gnome-shell/extensions/$UUID"

# Chromium-based browsers and their per-user NativeMessagingHosts folders.
BROWSERS=(
  "google-chrome" "google-chrome-beta" "google-chrome-unstable" "chromium"
  "BraveSoftware/Brave-Browser" "microsoft-edge" "vivaldi"
)

stop_player() {
  gdbus call --session -d io.github.alphachief13.YtFocus -o /io/github/alphachief13/YtFocus \
    -m io.github.alphachief13.YtFocus.Quit >/dev/null 2>&1 || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  gnome-extensions disable "$UUID" 2>/dev/null || true
  stop_player
  rm -rf "$EXT_DIR" "$APP_DIR"
  for b in "${BROWSERS[@]}"; do rm -f "$CONF/$b/NativeMessagingHosts/$HOST_NAME.json"; done
  echo "Focus panel removed."
  exit 0
fi

# Chrome derives an unpacked extension's ID from its absolute path.
unpacked_id() {
  printf '%s' "$1" | sha256sum | cut -c1-32 | tr '0-9a-f' 'a-p'
}

IDS=("$@")
[[ ${#IDS[@]} -eq 0 ]] && IDS=("$(unpacked_id "$REPO")")
for id in "${IDS[@]}"; do
  [[ "$id" =~ ^[a-p]{32}$ ]] || { echo "Invalid extension ID: $id" >&2; exit 1; }
done

missing=()
command -v gjs >/dev/null || missing+=(gjs)
gjs -c "imports.gi.versions.Soup = '3.0'; imports.gi.Soup;" >/dev/null 2>&1 || missing+=(libsoup3)
if ((${#missing[@]})); then
  echo "Missing: ${missing[*]}  (Fedora: sudo dnf install gjs libsoup3 · Debian/Ubuntu: sudo apt install gjs gir1.2-soup-3.0)" >&2
  exit 1
fi

# 1. Native host + shared modules (library, session and settings stay) --------
mkdir -p "$HOST_DIR" "$APP_DIR/common"
rm -f "$HOST_DIR/iface.js"
install -m 0755 "$ROOT/host/focus-host.js" "$HOST_DIR/focus-host.js"
install -m 0644 "$ROOT"/common/*.js "$APP_DIR/common/"

# 2. Local player (yt-pod's engine) --------------------------------------------
if gjs -c "imports.gi.versions.WebKit = '6.0'; imports.gi.versions.Adw = '1'; imports.gi.WebKit; imports.gi.Adw;" >/dev/null 2>&1; then
  stop_player
  rm -rf "$APP_DIR/daemon"
  mkdir -p "$APP_DIR/daemon/page"
  install -m 0755 "$ROOT/daemon/main.js" "$APP_DIR/daemon/main.js"
  install -m 0644 "$ROOT"/daemon/page/*.js "$APP_DIR/daemon/page/"
  # Focus's own ad handling, same files the browser extension uses.
  install -m 0644 "$REPO/src/shared.js" "$REPO/src/ads.js" "$REPO/src/ads.css" "$APP_DIR/daemon/page/"
  echo "Local player installed (keeps playing with the browser closed)"
else
  rm -rf "$APP_DIR/daemon"
  echo "WebKitGTK 6 not found: the panel will only mirror the browser."
  echo "  (Fedora: sudo dnf install webkitgtk6.0 libadwaita gstreamer1-plugin-libav)"
fi

origins=""
for id in "${IDS[@]}"; do origins+="${origins:+, }\"chrome-extension://$id/\""; done
manifest=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Focus — bridge to the GNOME panel",
  "path": "$HOST_DIR/focus-host.js",
  "type": "stdio",
  "allowed_origins": [$origins]
}
EOF
)

found=0
for b in "${BROWSERS[@]}"; do
  [[ -d "$CONF/$b" ]] || continue
  mkdir -p "$CONF/$b/NativeMessagingHosts"
  printf '%s\n' "$manifest" > "$CONF/$b/NativeMessagingHosts/$HOST_NAME.json"
  echo "Host registered for $b"
  found=1
done
if ((!found)); then
  mkdir -p "$CONF/google-chrome/NativeMessagingHosts"
  printf '%s\n' "$manifest" > "$CONF/google-chrome/NativeMessagingHosts/$HOST_NAME.json"
  echo "Host registered for google-chrome"
fi

# 3. GNOME Shell extension -----------------------------------------------------
if ! command -v gnome-shell >/dev/null; then
  echo "GNOME Shell not found: host installed, panel skipped."
  exit 0
fi
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
cp -r "$ROOT/extension/." "$EXT_DIR/"
cp "$ROOT/common/iface.js" "$EXT_DIR/iface.js"
echo "Panel installed in $EXT_DIR"

if [[ -n "${YTFOCUS_NO_ENABLE:-}" ]]; then
  :
elif gnome-extensions enable "$UUID" 2>/dev/null; then
  echo "Panel enabled."
else
  # Wayland: the running shell can't see a new extension. Pre-enable it so it
  # comes up on the next login without any extra command.
  current="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo "@as []")"
  if [[ "$current" != *"'$UUID'"* ]]; then
    if [[ "$current" == "@as []" || "$current" == "[]" ]]; then next="['$UUID']"; else next="${current%]}, '$UUID']"; fi
    gsettings set org.gnome.shell enabled-extensions "$next" 2>/dev/null || true
  fi
  echo "On Wayland GNOME only loads new extensions at login: log out and back in once."
  echo "(It is already marked as enabled; it will appear by itself.)"
fi

echo
echo "Last step: Focus settings (☰ → Ajustes → Painel do desktop) → turn it on."
echo "Extension ID(s) allowed: ${IDS[*]}"
