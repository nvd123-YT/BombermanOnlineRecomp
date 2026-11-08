# Porting / toolchain notes

## This machine (macOS ARM64, 8 GB)

| Tool | Location | State |
|---|---|---|
| dreamcomp | `~/Tools/dreamcomp` | framework + `.venv` + `build-libchdr/libchdr.dylib` |
| Python venv | `~/Tools/dreamcomp/.venv` | includes `ninja`, `pycdlib`; `python` symlink present |
| CMake | `~/.local/cmake-4.4.4-macos-universal/.../cmake` | 4.4.4 |
| Ninja | `~/Tools/dreamcomp/.venv/bin/ninja` | not on default PATH -> use `tools/env.sh` |
| SDL3 | `~/.local/SDL3` | found by CMake (`SDL3_DIR`) |
| Vulkan / glslc / MoltenVK | — | **missing**; windowed renderer skipped |
| Java | `~/Tools/jdk-21` | 21.0.13 |
| Ghidra | `~/Tools/ghidra_12.1.4_PUBLIC` | includes `SuperH4` processor module |
| REA | `npx rea-agents@6.8.0 mcp` | 229 tools; no SH-4 raw import |

`tools/dc.sh` sources `tools/env.sh`, which puts the venv on PATH and exports `DCDISC_LIBCHDR`.
Without it, `dcdisc` cannot read the CHD and `dc.py doctor` reports ninja/python missing.

## Build modes

```sh
tools/dc.sh build . --headless     # -DDREAM_RENDERER=OFF; runtime + translator only
tools/dc.sh build .                # attempts the Vulkan/SDL3 window; skipped here for now
```

The generated unit is ~179 MB of C++ and compiles with `-O1` (forced by `DreamAddGame.cmake` for
generated units). On this machine clang peaks around 0.3–0.8 GB RSS for that unit; the build is
single-unit-bound.

## Analysis setup

```sh
JAVA_HOME=$HOME/Tools/jdk-21 \
  ~/Tools/ghidra_12.1.4_PUBLIC/support/analyzeHeadless \
  ~/Tools/BombermanOnline-analysis/ghidra BombermanOnline \
  -import ~/Tools/BombermanOnline-private/1ST_READ.plain.bin \
  -processor SuperH4:LE:32:default -loader BinaryLoader -loader-baseAddr 0x0C010000
```

Seeds are applied with `-preScript SeedSH4.java`; helper scripts (`SeedSH4.java`, `DumpAsm.java`)
live in `~/Tools/BombermanOnline-analysis/scripts`. Addresses in Ghidra are the P0 link space
(`0x0C......`), not the `0x8C......` runtime alias.

### REA limitation (verified)

`rea-agents@6.8.0` maps raw-binary architectures only for 6502, m68k, x86, x86_64, ARM, AArch64
(`dist/ghidra/GhidraRawBinaryLanguage.js`), and `open_binary` rejects a `.gpr`. Opening the Ghidra
project also failed (`unsupported_target`). Do not spend time retrying those calls; use Ghidra
headless for SH-4 and REA for artifacts it supports.

## Known framework notes

- `dream_add_game` derives relocation unit names from `[[relocations]] dest`; no relocations are
  configured yet.
- `DREAM_DEV_INTERPRETER=ON` by default in a port, so untranslated code degrades to the interpreter
  and is reported instead of faulting.
- A missing `symbols.tsv` is fine; functions are named by address until a Ghidra export exists.
