#!/usr/bin/env bash
# Renders every mockup scene to mockup/shots/<scene>.png at 1440x900.
# Usage: mockup/render.sh [scene ...]   (needs google-chrome and python3)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8765}"
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser)}"
SCENES=("$@")
[ ${#SCENES[@]} -eq 0 ] && SCENES=(watch cover dark idle menu library playlist settings pop ad home results off)

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
PROFILE="$(mktemp -d)"
trap 'kill $SERVER 2>/dev/null; rm -rf "$PROFILE"' EXIT
sleep 0.6

mkdir -p mockup/shots
for s in "${SCENES[@]}"; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
    --user-data-dir="$PROFILE" --window-size=1440,900 --force-device-scale-factor=1 \
    --virtual-time-budget=4000 \
    --screenshot="mockup/shots/$s.png" \
    "http://127.0.0.1:$PORT/mockup/index.html?scene=$s" >/dev/null 2>&1
  echo "mockup/shots/$s.png"
done
