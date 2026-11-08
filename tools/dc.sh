#!/bin/sh
# Run dreamcomp's workflow CLI with this port's local toolchain environment.
#   tools/dc.sh doctor
#   tools/dc.sh build .
#   tools/dc.sh report . --frames 600
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/env.sh"
exec "$DREAMCOMP_DIR/.venv/bin/python" "$DREAMCOMP_DIR/tools/dc.py" "$@"
