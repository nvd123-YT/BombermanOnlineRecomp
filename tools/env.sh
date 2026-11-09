#!/bin/sh
# Local toolchain environment for this port. Source it, or use tools/dc.sh.
# Nothing here installs anything system-wide: the framework venv already carries ninja and python.

DREAMCOMP_DIR="${DREAMCOMP_DIR:-$HOME/Tools/dreamcomp}"
export DREAMCOMP_DIR
export PATH="$DREAMCOMP_DIR/.venv/bin:$PATH"

# dcdisc needs libchdr for CHD images; the framework built it here.
if [ -z "$DCDISC_LIBCHDR" ] && [ -f "$DREAMCOMP_DIR/build-libchdr/libchdr.dylib" ]; then
    DCDISC_LIBCHDR="$DREAMCOMP_DIR/build-libchdr/libchdr.dylib"
    export DCDISC_LIBCHDR
fi

export JAVA_HOME="${JAVA_HOME:-$HOME/Tools/jdk-21}"
export GHIDRA_HOME="${GHIDRA_HOME:-$HOME/Tools/ghidra_12.1.4_PUBLIC}"

# Reverse-engineering work lives outside the repository (no databases are committed).
export BMO_ANALYSIS_DIR="${BMO_ANALYSIS_DIR:-$HOME/Tools/BombermanOnline-analysis}"
