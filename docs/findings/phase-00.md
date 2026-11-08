# Phase 00 — survey and foundation (2026-11-04)

## Inputs (read-only)

- CHD: `~/Downloads/Bomberman Online (USA).chd`
- Extracted tree: `~/Tools/BombermanOnline-private`
- Framework: `~/Tools/dreamcomp`
- Ghidra: `~/Tools/ghidra_12.1.4_PUBLIC` (SuperH4), Java 21 at `~/Tools/jdk-21`

## Disc survey

`dcdisc info` (with `DCDISC_LIBCHDR=~/Tools/dreamcomp/build-libchdr/libchdr.dylib`):

```
Title:      BOMBERMAN ONLINE
Product:    MK-51065 V1.004 (20011004)
Company:    SEGA ENTERPRISES
Regions:    USA
Boot file:  1ST_READ.BIN
Device:     2FC5 GD-ROM1/1  CRC ok
WinCE:      no
```

`dcdisc ls` confirms exactly these files: `0GDTEX.PVR`, `1ST_READ.BIN`, `MAIGO.BIN`,
`BOMBER.AFS`, `BBA/{BACKDROP,CONTROL,FONT}.PVR`, `BBA/{FM_UTL,FM_UTL_PPPOE}.BIN`.

## Executable representation

`1ST_READ.plain.bin` and `fs/1ST_READ.BIN` are identical:

```
SHA-1   26fb8164ab585714bf384eadcfe97734d212240d
SHA-256 a05630d7b4aed49894f2ae68abd8f0276bfd0ac12415e5ad1457296059f2a5f8
size    2543588
```

First bytes `09 00` repeated = SH-4 `nop` padding, then a valid loader. This is **plain**, not
MIL-CD scrambled. `dc.py setup` extracted and verified it.

## First Ghidra import

- Raw binary at base `0x0C010000`, language `SuperH4:LE:32:default`.
- Loader stub `0x0C010000` -> `jmp 0x8C1D5FA0`.
- `0x0C1D5FA0` is C-runtime start; `main` thunk at `0x0C05BB80`.
- After seeding both, auto-analysis reported 955 functions; the dreamcomp translator's own
  pointer/sweep discovery found **16,223** functions (see below). Ghidra needs further seeding or
  the translator's function list imported to reach parity.

## First translation

`dream-translate` (invoked by the build) produced:

```
functions 16223
instructions 1123102
not lowered 85
direct jsr/bsrf calls 34649
switch tables 37 of 31 discovered
entry modes inferred 0 (ambiguous 16216)
```

The generated unit is `build/game/gen/bomberman_online.cpp` (179 MB). No `[[relocations]]` yet.

## Networking observations

See `docs/GAME-INTERNALS.md` for the full table. Key strings:

- `master.bomberman-hudson.games.sega.net`
- `kkClient Ver 2.1 Build:Oct  4 2001 23:51:57`, `CKageApp`, `kkLoginClient()`
- `NexGenPPP v1.2`, `NexGenPPPoE Ver.1.2`, `CNgnPPP`
- `ADNS`, `DHCP`, `DNS 1/2`, `Use PPPoE`, `Use DHCP`
- `2: (-) Select ISP1 (MODEM) Setting`, `4: (-) Select BBA Setting`
- `CLobby`, `CGameRoom`, `CBattleClient`, `CNetworkClient`, `CNetworkServer`

`FM_UTL.BIN` and `FM_UTL_PPPOE.BIN` are Katana shared libraries with SH-4 code and network
configuration strings (see GAME-INTERNALS). `MAIGO.BIN` is a 14,856-byte SH-4 module
("MAIGO Ver.1.103") referenced as `maigo.bin`.

## Repo changes in this phase

Created: `CMakeLists.txt`, `game/CMakeLists.txt`, `game/bomberman_online.toml`,
`src/bomberman_online.cpp`, `.gitignore`, `.gitattributes`, `README.md`, `CLAUDE.md`, `LICENSE`,
`tools/env.sh`, `tools/dc.sh`, `docs/PLAN.md`, `docs/GAME-INTERNALS.md`, `docs/PORTING.md`,
`docs/findings/phase-00.md`.

Not committed. No game data copied into the repository.

## Open items

1. First build must finish and a report must be read before the translation is called clean.
2. Ghidra function inventory must be aligned with the translator's 16,223 functions for naming.
3. Overlay/relocation detection.
4. Windowed macOS renderer dependency strategy.
