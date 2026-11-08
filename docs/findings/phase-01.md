# Phase 01 — first boot report and config discovery (2026-11-04)

## Build

`tools/dc.sh build . --headless` completed:

- executable `build/game/bomberman-online` (78 MB)
- generated unit 179,325,388 bytes, compiled in ~12 minutes at `-O1` (clang peak ~0.55 GB RSS)
- five relocation units generated after the first report; see below

## First run (`report --frames 600`)

Command (via `tools/dc.sh report . --frames 600 -- --suggest-config game/suggested.toml`):

```
untranslated call targets: 7434
unmapped memory accesses: 5
  0xa0600000 r1 x1
  0xa0600004 r1 x1
  0xa1000400 r4 x1
  0xa1000800 r4 x1
  0xa1001400 r4 x1
```

Subsystem activity:

```
ch2 DMA: 1153 transfers (8160256 TA bytes, 74240 texture bytes, 0 refused),
         0 sort-DMA starts, 0 manual DMAC transfers
G2 DMA: 10 transfers (1343648 bytes, 1343648 to sound RAM), 0 refused
AICA: arm7 running at pc 0x00001d08, 433709 samples, 26263263 ARM instructions,
      9068 FIQs, 0 SWIs, 12590 timer irqs, 0 key-ons, 0 non-zero samples
holly: ...; GD-ROM DMA irq clear
```

Interpretation:

- The guest runs 600 frames, drives the PVR2 TA (8.1 MB of display-list data, 74 KB textures)
  and loads/executes the AICA ARM7 firmware. **[observed]**
- `0 sort-DMA starts` and `0 key-ons` mean no finished scene render and no sound yet in this
  window. The game is still in early startup/menu construction at frame 600. **[derived]**
- The five unmapped reads are at hardware register addresses (`0xA0600000/4`, `0xA1000400/800/1400`),
  referenced from literals at `0x0C1E964C..0x0C1E9674`. They are not guest RAM. Treat as a
  runtime map gap, not a game bug, until the access PCs are traced. **[derived]**

## Runtime-copied code found (relocations)

The runtime matched RAM against the image and reported:

| Dest | Source | Size |
|---|---|---|
| `0x8C000000` | `0x0C22E970` | `0x34` |
| `0x8C000100` | `0x0C22E8DC` | `0x34` |
| `0x8C000400` | `0x0C22E8DC` | `0x34` |
| `0x8C000600` | `0x0C22E914` | `0x58` |
| `0x8C00F3FC` | `0x0C1BE6A4` | `0x2CC` |

These are the exception/interrupt entry area and the Katana system-variable/handler block.
They were pasted into `game/bomberman_online.toml` with `[[relocations]]`.

The run also suggested three call targets inside the image: `0x0C0F85AE`, `0x0C0F85C2`,
`0x0C0F85CE` (called 498/582/1076 times). They are in `[functions] extra`; re-measure after the
relocations are translated.

## Networking evidence found while the build ran

- `main` is `0x0C010080` (the C-runtime start at `0x0C1D5FA0` jumps through `0x0C05BB80`, whose
  literal is `0x8C010080`).
- `0x0C010080` checks `0x8C28582C == 1`, then calls `LoadLibrary`-style code at `0x8C1D92DA`
  with `"\` + "maigo.bin"`, and resolves symbols at `0x8C1D8A4A` / `0x8C1D8B22`.
- `0x0C0108E4` builds a descriptor `{1, "BBA", "FM_UTL_PPPOE.BIN", 0}` at `0x8C28582C` and is
  referenced from a literal at `0x0C1CC6D0`.
- The exact string `FM_UTL.BIN` is **not** present in `1ST_READ.BIN`; only `FM_UTL_PPPOE.BIN` is
  referenced by name. This does not prove `FM_UTL.BIN` is unused (it may be selected by config),
  but it is a concrete negative result.
- The master host string `master.bomberman-hudson.games.sega.net` is at `0x0C18164C`; its P1
  literal is referenced from `0x0C023A30` and six nearby table entries (`0x0C023A30..0x0C023A50`).

## Environment fixes

- `tools/env.sh` / `tools/dc.sh`: put the dreamcomp venv (ninja, python) on PATH and export
  `DCDISC_LIBCHDR`. `dc.py doctor` now reports only Vulkan missing.
- Patched `~/Tools/dreamcomp/tools/dc.py` `port_info()` to require an executable file: the glob
  `build/game/*` was selecting the generated `bomberman_online_port_version.cpp` as the launcher.
  This is a framework tool bug, not an engine change.
- Added `BMO_FAST_BUILD` (default OFF) to compile the generated unit at `-O0` during config
  discovery.

## Next

1. Finish the rebuild with the relocations and `BMO_FAST_BUILD=ON`.
2. Re-run `report --frames 600`; expect the 0x8C000xxx targets to disappear.
3. Trace the five hardware-register reads to their PCs.
4. Get a windowed build or a TA dump so the title/menu state is visible.
