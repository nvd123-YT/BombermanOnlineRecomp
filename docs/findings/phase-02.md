# Phase 02 — clean translation, expansion-device probes, windowed build (2026-11-04)

## Translation is complete

After adding the last discovery seed (`0x0C0A40EE`, called once) to `[functions] extra` and the
five runtime relocations, a 600-frame run reports:

```
untranslated call targets: 0
unmapped memory accesses: 5
```

`--suggest-config` wrote “nothing to add”, so every call target the guest reached is now
translated. **[observed]**

## The five unmapped accesses are expansion-device probes

`build/report3.log` records the first access at frame 24 and the full fault list:

| Address | Size | Direction | Meaning |
|---|---|---|---|
| `0xA0600000` | 1 | read | Dreamcast modem: general id/enable register |
| `0xA0600004` | 1 | read | Dreamcast modem: first controller register |
| `0xA1000400` | 4 | read | G2 expansion-device area |
| `0xA1000800` | 4 | read | G2 expansion-device area |
| `0xA1001400` | 4 | read | Broadband Adapter (HIT-0400) bridge base |

Evidence:

- `0xA0600000–0xA06007FF` is the modem / LAN-adapter (HIT-0300) window. Modem registers 0x00–0x1F
  are mapped at `0xA0600004` and following; `0xA0600000` is the modem id/enable register
  (DCEmulation modem notes; jj1odm G2-bus analysis). **[observed, external documentation]**
- `0xA1001400` is the address jj1odm documents for the BBA (HIT-0400) GAPS PCI bridge. **[observed,
  external documentation]**
- The same five literals occur in both `fs/BBA/FM_UTL.BIN` (file offsets `0x638D4..0x638FC`) and
  `fs/BBA/FM_UTL_PPPOE.BIN` (`0x63994..0x639BC`), in the same probe routine, with the two files
  differing by 0xC0 bytes at that point. So the modem and BBA probes are shared between the two
  utility builds; the filename difference is not what selects the probe. **[observed]**
- `1ST_READ.BIN` has the same probe at `0x0C1E95A4..0x0C1E95C6`; the wrapper at `0x0C1E9750`
  switches to privileged mode and calls `0x8C1EA11C`, and the literal pool next to it contains
  the ASCII `GAPS` bridge id (`0x53504147` at `0x0C1E97C0`). This ties the main executable's
  probe to the BBA bridge, not to a generic memory read. **[observed]**
- The probe treats a register value of `0xFFFFFFFF` as “device absent” (`cmp/eq #-1`), so the
  runtime returning `0` for an unmapped read is the wrong value: it makes the guest believe a
  device answered. **[derived]**

Open question: `0xA1000400` and `0xA1000800` are not yet named. They are in the same G2 expansion
window as the BBA base and are probed by the same routine; a later phase should decide whether
they are the modem/LAN-adapter bridge or unused aliases. **[unresolved]**

## Windowed macOS build unblocked locally

The renderer needs three things this machine did not have: Vulkan headers, a Vulkan
implementation, and `glslc`. All are now provided without a system-wide install:

| Piece | Location | Source |
|---|---|---|
| Vulkan headers + MoltenVK dylib | `~/.local/MoltenVK/...` | official `MoltenVK-macos.tar` release (Apache-2.0) |
| `glslc` replacement | `~/.local/bmo-tools/glslc-bmo` | `tools/glslc_shim.c` + `tools/setup_glslc.sh`, driving the libshaderc already shipped by mpv |

Configure with:

```sh
MVK="$HOME/.local/MoltenVK/MoltenVK/MoltenVK"
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DDREAMCOMP_DIR="$DREAMCOMP_DIR" -DBMO_FAST_BUILD=ON -DDREAM_RENDERER=ON \
  -DVulkan_INCLUDE_DIR="$MVK/include" \
  -DVulkan_LIBRARY="$MVK/dynamic/dylib/macOS/libMoltenVK.dylib" \
  -DDREAM_GLSLC="$HOME/.local/bmo-tools/glslc-bmo" \
  -DCMAKE_BUILD_RPATH="$MVK/dynamic/dylib/macOS"
```

This is a local development arrangement, not a packaging decision: a release bundle still has to
ship MoltenVK beside the executable (Apache-2.0, dynamically linked).

## Input and launcher

- Keyboard controls are the framework's `Bindings` table: arrows = d-pad/stick, Z = A, X = B,
  A = X, S = Y, Return/Space = Start, Q/W = triggers. F1 opens the binding screen and writes the
  user copy; `game/bindings.txt` is the port's documented default.
- `tools/launcher.py` is a Tk launcher: disc selection (remembered in `.dreamcomp/local.json`),
  play/headless/build buttons, a controls view, and a streaming log. It is a development entry
  point; it can be folded into the executable once the windowed path is packaged.

## Not verified

- The windowed executable has not been run against the title yet at the time of writing; the build
  was still linking. Do not mark the windowed path verified until a screenshot or a guest frame is
  observed.
- The five device registers are still unmapped in the runtime. The title boots and reaches the
  frame limit with the wrong “present” value, but no network code has been exercised.
