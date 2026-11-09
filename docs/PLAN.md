# Plan — Bomberman Online native recompilation

Objective: a native, playable recompilation of the original Dreamcast game with working original
online multiplayer, including interoperability with Dreamcast Live. Not an emulator wrapper and not
a remake.

Working rule: every checkpoint is a visible result plus evidence. A row is only "verified" when a
command/observation is recorded here.

## Milestones and gates

| # | Milestone | Entry gate | Exit criterion |
|---|---|---|---|
| 1 | Foundation | disc + framework present | port builds; translation report read; Ghidra project created |
| 2 | Startup and loop | M1 | entry, init chain, main loop, graphics/input/audio init identified; native infrastructure started |
| 3 | Networking | M2 | modem/BBA paths, FM_UTL binaries, login, lobby, room, chat, sync documented with evidence |
| 4 | Native game | M3 | title/menu/arena/gameplay/assets/audio reachable natively |
| 5 | Online | M4 | original protocol implemented and validated against captures/clients |
| 6 | Platforms | M5 | macOS, then Windows/Linux builds and packaging |

## Decisions log

| # | Decision | Why |
|---|---|---|
| D1 | Port id `bomberman_online`, executable `bomberman-online` | matches framework naming; no existing port |
| D2 | Analysis project outside the repo (`~/Tools/BombermanOnline-analysis`) | Ghidra DBs are large and must not be committed |
| D3 | Ghidra headless is primary disassembler; REA secondary | REA 6.8.0's raw-binary import has no SH-4 language mapping (verified in `GhidraRawBinaryLanguage.js`); Ghidra 12.1.4 ships `SuperH4` |
| D4 | Headless build first on this 8 GB machine | avoids Vulkan/SDL window dependency while translation is validated |
| D5 | Do not install a Vulkan SDK | user constraint; macOS window path needs a non-system MoltenVK/glslc solution |
| D6 | Device registers mapped as absent via `on_start` MMIO handlers | guest probes expect `0xFFFFFFFF` for no device; returning `0` wrongly signals presence |

## Verified checkpoints

| Date | Checkpoint | Evidence |
|---|---|---|
| 2026-11-04 | Disc identity: BOMBERMAN ONLINE, MK-51065 V1.004, USA, boot `1ST_READ.BIN` | `dcdisc info` on CHD; IP.BIN bytes |
| 2026-11-04 | Boot file is stored plain (GD-ROM), not MIL-CD scrambled | SHA-1 `26fb8164ab585714bf384eadcfe97734d212240d` of both `1ST_READ.plain.bin` and `fs/1ST_READ.BIN`; `dcdisc setup` verified it |
| 2026-11-04 | Port scaffold created, `dc.py setup` extracts and verifies the boot file | `.dreamcomp/local.json`, `game/extracted/fs/1ST_READ.BIN` |
| 2026-11-04 | Ghidra project imports SH-4 raw binary at `0x0C010000` | `analyzeHeadless ... -processor SuperH4:LE:32:default` |
| 2026-11-04 | First translation: 16,223 functions, 1,123,102 instructions, 85 words not lowered | `build/game/gen/bomberman_online.report.txt` |
| 2026-11-04 | First headless boot: 600 frames, PVR TA active, AICA ARM7 running | `docs/findings/phase-01.md` |
| 2026-11-04 | Runtime-copied interrupt stubs identified and added as relocations | five `[[relocations]]` in `game/bomberman_online.toml` |
| 2026-11-04 | Windowed macOS build: Vulkan renderer enabled via local MoltenVK + glslc shim | `BUILD_EXIT=0`, runs through MoltenVK on Apple Silicon, `unmapped memory accesses: 0` |
| 2026-11-04 | Five expansion-device probes mapped as absent devices | `src/bomberman_online.cpp`: `AbsentDevice` MMIO handler returns `0xFFFFFFFF` for `0xA0600000-0xA06007FF` (modem), `0xA1000400`, `0xA1000800` (G2), `0xA1001400` (BBA); headless + windowed both report `unmapped memory accesses: 0` |
| 2026-11-04 | Keyboard controls documented; launcher GUI (`tools/launcher.py`) constructs and closes | `game/bindings.txt`, `tools/launcher.py`, verified via `importlib` smoke test |
| 2026-11-05 | Four new function seeds merged into `game/bomberman_online.toml` | `0x0C1EA932`, `0x0C1EA93C`, `0x0C1EAA04`, `0x0C1EAA16`; headless report now `untranslated call targets: 0`, `unmapped memory accesses: 0` |
| 2026-11-05 | Renderer fix: depth bias for translucent sort | `engine/render/src/vk/renderer.cpp`: translucent strips sorted by depth + insertion-order bias (`order * 1e-6`) to break near-equal depth ties deterministically; `DREAM_GRAPHICS_LOG=1` and `DREAM_DUMP_SPRITES=1` env vars for per-frame debugging | Depth bias applied but menu flickering still persists — needs per-pixel translucent sort or larger bias |
| 2026-11-05 | Game-INTERNALS.md: asset formats documented | PVR header structure (GBIX+PVRT, offset 16 pixel format, offset 24/28 width/height), AFS archive format (AFS\0 magic, 9759 entries, offset+size pairs), concrete hex values from 0GDTEX.PVR and FONT.PVR | Framework-level renderer fix still needed for menu; AFS/PVR decoding needed for native assets |

## Current blockers

| Blocker | Status |
|---|---|
| Windowed macOS build | RESOLVED — local MoltenVK at `~/.local/MoltenVK/...`, glslc shim at `~/.local/bmo-tools/glslc-bmo` |
| REA SH-4 import | Ghidra headless is primary; REA cannot open SH-4 raw binaries (verified) |
| Generated code size: 179 MB C++ | Emitted as 8 translation units; compiles in parallel; 8 GB memory sufficient |
| Ghidra `.gpr` project corrupted | `BombermanOnline.gpr` was 0 bytes; recreated but Ghidra reports "marker file not found"; needs fresh project creation in Ghidra GUI |
| Menu rendering (renderer-level) | Insertion-order fix applied but flickering persists; needs per-pixel translucent sort or depth bias in dreamcomp renderer |

## Open issues

## Current blockers

| Blocker | Status |
|---|---|
| Windowed macOS build | RESOLVED — local MoltenVK at `~/.local/MoltenVK/...`, glslc shim at `~/.local/bmo-tools/glslc-bmo` |
| REA SH-4 import | Ghidra headless is primary; REA cannot open SH-4 raw binaries (verified) |
| Generated code size: 179 MB C++ | Emitted as 8 translation units; compiles in parallel; 8 GB memory sufficient |
| Ghidra `.gpr` project corrupted | `BombermanOnline.gpr` was 0 bytes; recreated but Ghidra reports "marker file not found"; needs fresh project creation in Ghidra GUI |
| Menu rendering (renderer-level) | VRAM dirty tracking fix: SH-4 writes VRAM through 64-bit view (0x06000000-0x07FFFFFF) which goes through `vram_map32()` address remapping in `resolve()`. `mark_vram()` marked the remapped address as dirty, but `info.address` from `tcw_address()` stores raw TCW addresses. Texture cache invalidation checked raw TCW addresses against dirty ranges → mismatch → stale texture data. Fix: added `mark_vram_raw(offset, size)` that marks raw VRAM offsets, called from `store()` and `sq_flush()` alongside `mark_vram()`. Also: sprite plane solver init corner 0 z/u/v when degenerate; vertex buffer ring increased 4→16. |
| PVR/AFS asset decoding | Documented but not decoded; needs PVR pixel format determination and AFS entry classification |

## Open issues

| Issue | Description | Next step |
|---|---|---|
| Menu rendering | Gameplay and cutscenes render fine, but the main menu shows severe visual bugs (flickering, misplaced sprites, warping background, shaking). **VRAM dirty tracking fix applied**: SH-4 writes VRAM through `0x06000000-0x07FFFFFF` (area 1 64-bit view) which goes through `vram_map32()` address remapping. `mark_vram()` marked remapped address as dirty, but `tcw_address()` returns raw TCW addresses. Texture cache invalidation checked raw TCW addresses against dirty ranges → mismatch → stale texture data for backgrounds loaded from AFS. Fix: `mark_vram_raw(offset)` uses raw offset from guest address (`a & 0x007FFFFF`), called from `store()` and `sq_flush()`. Also: sprite plane solver init corner 0 z/u/v when degenerate (`k3==0`); vertex `v{}` zero-init; vertex buffer ring 4→16. **2026-11-05 update**: log analysis traced the broken background to a streamed YUV 4:2:2 video texture (512x256, linear, no palette) re-decoded every frame at VRAM `0x314000/0x354000/0x394000/0x720640/0x760640`; all other menu textures are pal4 and decode fine; green/magenta streaks + animated tearing point at YUV chroma handling. `DREAM_TRACE_YUV` added (converter macroblock writes + decode row words); build + headless verify clean (untranslated 0 / unmapped 0). Next: capture YUV trace during menu run, then fix converter/decode pairing. **Windowed test needed**: launch with `DREAM_TRACE_INVALIDATE=1` + `DREAM_TRACE_VRAM=1` + `DREAM_DUMP_TEXTURES=1` + `DREAM_TRACE_YUV=1`, observe menu background. |
| Ghidra function naming | Startup chain and networking functions need to be named in Ghidra and exported as `symbols.tsv` | Create fresh Ghidra project (delete corrupted `.gpr`/`.rep`, import `1ST_READ.BIN` with SuperH4 LE at `0x0C010000`, name functions, export `symbols.tsv`) |
| FM_UTL / networking investigation | FM_UTL loading chain documented but not verified against Ghidra disassembly; Kage protocol strings found but call sites not traced | Investigate loading paths in Ghidra around `0x0C0108E4` and `0x0C010080`, trace Kage protocol usage |
| PVR/AFS asset decoding | PVR header structure documented (GBIX+PVRT, pixel format at offset 16, width/height at 24/28), AFS format documented (9759 entries, offset+size pairs). Actual decoding not done. | Decode PVR pixel formats, parse AFS index, classify entries as overlays vs assets |

## Next concrete task

1. Fix menu rendering in dreamcomp renderer — implement per-pixel translucent sort or tune depth bias in `renderer.cpp:465-477`, test with `DREAM_DUMP_SPRITES=1`
   **2026-11-05 update**: renderer-level suspects exhausted for flicker (sort order, fog, clip, modvol, depth bias all toggled clean). New primary suspect: streamed YUV 4:2:2 menu background; `DREAM_TRACE_YUV` added, need captured data.
2. Decode PVR pixel formats and parse AFS index for native asset loading (Milestone 4)
3. Create fresh Ghidra project and name functions for Milestone 3 networking (Milestone 3)
