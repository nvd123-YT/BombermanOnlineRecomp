#!/bin/sh
# Build the local glslc replacement used by the Vulkan renderer.
#
# macOS here has no Vulkan SDK. The machine already carries libshaderc inside mpv; this script
# compiles tools/glslc_shim.c against it and installs both under ~/.local/bmo-tools, never
# system-wide. Re-run it if the shim changes.
#
#   tools/setup_glslc.sh
#   cmake ... -DDREAM_GLSLC="$HOME/.local/bmo-tools/glslc-bmo"
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
PREFIX="${BMO_TOOLS_PREFIX:-$HOME/.local/bmo-tools}"
SHADERC_LIB="${SHADERC_LIB:-$HOME/Tools/mpv/mpv-arm64-0.40.0/mpv.app/Contents/MacOS/lib/libshaderc_shared.1.dylib}"

if [ ! -f "$SHADERC_LIB" ]; then
    echo "libshaderc not found: $SHADERC_LIB" >&2
    echo "set SHADERC_LIB to a libshaderc_shared dylib and re-run" >&2
    exit 1
fi

mkdir -p "$PREFIX/lib"
cp "$SHADERC_LIB" "$PREFIX/lib/libshaderc_shared.1.dylib"

# The dylib's install name is @executable_path/lib/libshaderc_shared.1.dylib, so the executable
# must sit one directory above the copy above. That keeps the layout relocatable and avoids
# install_name_tool.
clang -O2 -Wall -Wextra "$HERE/glslc_shim.c" \
    -L"$PREFIX/lib" -lshaderc_shared.1 -o "$PREFIX/glslc-bmo"

# Smoke test: compile the renderer's simplest shader and check the SPIR-V magic.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
"$PREFIX/glslc-bmo" --target-env=vulkan1.1 -O -mfmt=c \
    -o "$TMP/test.inc" "$HOME/Tools/dreamcomp/engine/render/shaders/triangle.vert" 2>/dev/null || {
        # A checkout elsewhere: use a tiny inline shader instead.
        printf '#version 450\nvoid main(){gl_Position=vec4(0.0);}\n' > "$TMP/test.vert"
        "$PREFIX/glslc-bmo" --target-env=vulkan1.1 -O -mfmt=c -o "$TMP/test.inc" "$TMP/test.vert"
    }
head -c 11 "$TMP/test.inc" | grep -q '{0x07230203' || {
    echo "shim output does not start with SPIR-V magic" >&2
    exit 1
}
echo "installed $PREFIX/glslc-bmo"
