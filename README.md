# Bomberman Online — native recompilation

A native C/C++ recompilation of **Bomberman Online** (Sega Dreamcast, USA, MK-51065 V1.004),
built on [dreamcomp](https://github.com/phobos665/dream-recomp)-style static SH-4 recompilation.

The original game is © SEGA / HUDSON SOFT. **This repository contains no game data.** You must
supply your own disc image. Original online multiplayer compatibility is a core requirement, not
an optional extra.

## What is here

| Path | Purpose |
|---|---|
| `game/bomberman_online.toml` | Measured game config for `dream-translate` (disc SHA-1, load/link address) |
| `src/bomberman_online.cpp` | Port registration and device/MMIO handlers (absent-device expansion registers) |
| `game/bindings.txt` | Documented default keyboard/gamepad input bindings |
| `tools/launcher.py` | Tk launcher GUI (disc selection, play/headless/build, controls view, log) |
| `tools/glslc_shim.c` / `tools/setup_glslc.sh` | Local glslc replacement driving mpv's libshaderc; no Vulkan SDK install |
| `docs/GAME-INTERNALS.md` | Reverse-engineered facts, with evidence and confidence |
| `docs/findings/` | Per-phase evidence, raw offsets and open questions |
| `docs/PLAN.md` | Milestones, gates, verified checkpoints |
| `tools/dc.sh` | Run dreamcomp's CLI with the local toolchain environment |
| `tools/env.sh` | Local paths (dreamcomp, Java, Ghidra, libchdr) — no system installs |

## Build

Prerequisites: the dreamcomp checkout at `~/Tools/dreamcomp` (or `$DREAMCOMP_DIR`), its Python
venv, and an extracted boot file from your own disc.

```sh
tools/dc.sh setup . --disc "/path/to/Bomberman Online (USA).chd"
tools/dc.sh build .            # headless-capable build
tools/dc.sh report . --frames 600
python tools/launcher.py       # Tk launcher GUI
```

The game executable is generated into `build/game/gen/` and is never committed. Windowed mode on
macOS uses locally installed MoltenVK (`~/.local/MoltenVK/...`) and the glslc shim
(`~/.local/bmo-tools/glslc-bmo`) — no system Vulkan SDK required.

## Status

Milestone 1 is in progress. See `docs/PLAN.md` for the current verified checkpoint and the exact
blockers. Do not read a row in this table as more than it says.

| Area | State |
|---|---|
| Disc identification, boot binary, first translation | implemented and verified |
| Native build | headless build verified; windowed macOS build verified via local MoltenVK + glslc shim |
| Expansion-device probes | all five mapped as absent devices (`0xFFFFFFFF` reads); `unmapped memory accesses: 0` headless + windowed |
| Translation coverage | `untranslated call targets: 0` after merging 4 modem/BBA function seeds (`0x0C1EA932`, `0x0C1EA93C`, `0x0C1EAA04`, `0x0C1EAA16`) |
| Startup/loop analysis | entry chain identified in Ghidra (`0x0C010000` -> CRT -> `main 0x0C010080`) |
| Keyboard controls | documented in `game/bindings.txt`; framework `Bindings::defaults()` provides arrows/Z-X-A-S/Return-Space/Q-W/F1 rebinding |
| Launcher GUI | `tools/launcher.py` (Tk): disc selection, play/headless/build/stop, controls view, streaming log |
| Ghidra function naming | startup chain identified; networking functions (`FM_UTL`, `CKageApp`, `CLobby`, `CGameRoom`, `CBattleClient`) not yet named in Ghidra |
| BBA/PPP utilities | investigated (static), not implemented |
| Online protocol | investigated at string/symbol level, not implemented |
| Gameplay/assets | not yet investigated in depth |
| Menu rendering | severe visual bugs (flickering, misplaced sprites, warping background) — framework renderer issue in translucent-list path |