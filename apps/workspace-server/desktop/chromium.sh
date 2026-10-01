#!/usr/bin/env bash
set -euo pipefail
# The workspace VM/container is the isolation boundary for this desktop spike.
exec /opt/playwright/chromium-*/chrome-linux*/chrome \
  --no-sandbox --no-first-run --no-default-browser-check \
  --user-data-dir="$HOME/.config/halo-chromium" "$@"
