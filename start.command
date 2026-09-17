#!/bin/bash
set -euo pipefail
DISTILLER_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$DISTILLER_DIR/.."
exec /opt/homebrew/bin/node "$DISTILLER_DIR/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" --offline -e "$DISTILLER_DIR" "$@"
