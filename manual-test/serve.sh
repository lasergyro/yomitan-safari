#!/bin/sh
set -eu

# Serve the manual test pages over http://127.0.0.1 so the Safari extension runs
# on them. Safari disables web extensions on file:// URLs, so these pages must be
# served over HTTP to be scannable.
#
# Usage:
#   ./manual-test/serve.sh           # serves on port 8723
#   PORT=9000 ./manual-test/serve.sh # custom port

DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
PORT="${PORT:-8723}"

printf 'Serving manual test pages at http://127.0.0.1:%s/\n' "$PORT"
printf '  - http://127.0.0.1:%s/test-plain.html   (single document)\n' "$PORT"
printf '  - http://127.0.0.1:%s/test-iframe.html  (embedded iframe)\n' "$PORT"
printf 'Press Ctrl+C to stop.\n'

exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR"
