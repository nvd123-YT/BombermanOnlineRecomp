# Bomberman Online — game internals

Facts are tagged **[observed]**, **[derived]**, or **[inferred]**. Addresses are P0 link-space
(`0x0C......`); the runtime also maps them at `0x8C......`. File offsets are from
`1ST_READ.plain.bin`.

## Identity

| Item | Value | Source |
|---|---|---|
| Title | BOMBERMAN ONLINE | IP.BIN / `dcdisc info` [observed] |
| Product | MK-51065 V1.004 (20011004) | IP.BIN [observed] |
| Region | USA | IP.BIN [observed] |
| Boot file | `1ST_READ.BIN`, 2,543,588 bytes | ISO9660 listing [observed] |
| Boot SHA-1 (plain) | `26fb8164ab585714bf384eadcfe97734d212240d` | `shasum -a 1` [observed] |
| Boot SHA-256 (plain) | `a05630d7b4aed49894f2ae68abd8f0276bfd0ac12415e5ad1457296059f2a5f8` | [observed] |
| CHD SHA-256 | `5e01678b27597d88dcc135b437615eb1878b7fd2bcf9b940ebed71ee0edb21f0` | user-provided, matches disc |
| Load address | `0x8C010000` | Katana convention; literal pools use `0x0C......` [observed] |

The retail GD-ROM stores `1ST_READ.BIN` in plain form. `fs/1ST_READ.BIN` and
`1ST_READ.plain.bin` are byte-identical, and `dcdisc setup` verified the SHA-1. No descrambling is
needed (contrast MIL-CD CD-R images).

## Toolchain / SDK fingerprints [observed]

`strings` on the boot file and `fs/BBA/FM_UTL.BIN`:

- `Shinobi Library for Dreamcast Version 1.73`, `Shinobi Ver 1.73 Build:Nov 05 2000 21:38:44`
- `kamui2 Ver 16,5,4,0`, `kmdk`, `kd`, `sy*`, `pd*`, `mw*` — Katana runtime libraries
- `031 Ninja DeepBlue`, `088 Shinobi Blue` — Ninja/Shinobi build names
- `Transport Ver 1.00 Build:Sep 26 2001`, `ETD Ver.1.01`, `NexGenPPP v1.2`,
  `NexGenPPPoE Ver.1.2 Build:Dec 18 2000`

## Startup chain [observed disassembly, derived meaning]

`0x0C010000` — Katana loader stub (32 bytes):

```
nop x6
mov.l 0x0c010024,r0   ; r0 = 0xff00001c
mov.l @r0,r1
mov.l 0x0c010028,r2   ; 0x000089af
and   r2,r1
mov.w 0x0c010020,r2   ; 0x0800
or    r2,r1
mov.l r1,@r0
mov.l 0x0c01002c,r0   ; 0x8c1d5fa0
jmp   @r0
nop
```

`0x0C1D5FA0` — C runtime start (48 bytes): saves PR, fills `0x8C00C000..0x8C00F400` with the word
`0x41474553` ("SEGA"), then:

```
bsr 0x0c1d5fe0        ; BSS/ctor helper
bsr 0x0c1d5fd0        ; -> jmp 0x8c1d9846 (init)
mov.l 0x0c1d6114,r2   ; 0x8c05bb80
jsr @r2               ; main
bsr 0x0c1d5fd8        ; -> jmp 0x8c1d989e (fini)
rts
```

- `main` thunk: `0x0C05BB80` = `mov.l 0x0c05bb88,r3; jmp @r3` (6 bytes); the literal is
  `0x8C010080`, so the real `main` is **`0x0C010080`**. [observed]
- `0x0C010080` checks `0x8C28582C == 1`, then calls a Katana loader at `0x8C1D92DA` with
  `"\` + `maigo.bin"` and resolves symbols through `0x8C1D8A4A` / `0x8C1D8B22`. [observed]
- `0x0C0108E4` fills a descriptor `{1, "BBA", "FM_UTL_PPPOE.BIN", 0}` at `0x8C28582C`; a literal
  at `0x0C1CC6D0` references this function. [observed]
- Init/fini: `0x0C1D9846`, `0x0C1D989E` (88 bytes each).
- The "SEGA" fill targets `0x8C00C000..0x8C00F400`; this is the area the Katana startup reserves
  around its system variables (`0x8C00F400` is the standard system-variable base in Crazy Taxi's
  config). **[derived]** — confirm against the disassembly before relying on it.

## Translation report (first run)

`build/game/gen/bomberman_online.report.txt`:

| Metric | Value |
|---|---|
| Functions | 16,223 |
| Instructions | 1,123,102 |
| Not lowered | 85 (mostly `.word` data misclassified in code gaps) |
| Direct jsr/bsrf calls | 34,649 |
| Switch tables | 37 of 31 discovered |
| FPSCR unknown summaries | 22; entry modes inferred 0 (ambiguous 16,216) |

No `[[relocations]]` are configured yet. The loader stub at `0x0C010000` is emitted, but the
program does not copy code from the boot image at runtime the way Crazy Taxi does — the jump target
`0x0C1D5FA0` is inside the same image. Confirm whether any overlay copy exists once the boot runs.

## Networking — static evidence

The boot executable contains the Sega/Katana network stack and the game's own C++ layer.

| Evidence | Meaning | Confidence |
|---|---|---|
| `master.bomberman-hudson.games.sega.net` | game master/login host | observed at `0x0C18164C` (string data); literal referenced from `0x0C023A30` and six nearby table entries (`0x0C023A30..0x0C023A50`) |
| `CKageApp`, `kkClient Ver 2.1 Build:Oct 4 2001`, `kkLoginClient()` | SegaNet "Kage" client login | observed |
| `CNgnPPP`, `NexGenPPP v1.2`, `NexGenPPPoE v1.2` | PPP and PPPoE stacks | observed |
| `ADNS`, `DHCP`, `DNS 1/2`, `Use PPPoE`, `Use DHCP` | address discovery/config | observed |
| `CLobby`, `CGameRoom`, `CNetworkClient`, `CNetworkServer`, `CBattleClient`, `CStoryClient` | lobby/room/battle state objects | observed |
| `?CPartsMenuLobby`, `?CPartsMakeRoom`, `?CPartsEnterRoom`, `?CPartsNetworkDialog` | menu/state classes | observed |
| `SendFastToServer`, `MapSendToServer`, `SERVER_START`, `CLI_SET_SETTLED` | game-side packet/commands | observed |
| `2: (-) Select ISP1 (MODEM)`, `4: (-) Select BBA Setting` | separate modem/BBA UI paths | observed |
| `FM_UTL_PPPOE.BIN`, `maigo.bin` | runtime-loaded libraries referenced by name | observed |

### `fs/BBA/FM_UTL.BIN` and `fs/BBA/FM_UTL_PPPOE.BIN`

Both begin with the Katana shared-library header (`nop` padding, `Lib Handle Start` at `+0x30`) and
contain SH-4 code, not data. They are loaded libraries, not configuration blobs.

| Item | FM_UTL.BIN | FM_UTL_PPPOE.BIN |
|---|---|---|
| Size | 438,820 | 439,012 |
| SHA-256 | `56f757ee...b5784` | `c5987a2d...b4502` |
| Katana libs | Shinobi 1.73, Kamui, `fmMng`, `ntInf/ntUtl/ntLD/ntIniMdm`, `sy*`, `pd*` | same + PPPoE-specific strings |
| PPPoE UI | `PPPoE Username/Password`, `Use PPPoE`, `my PPPoE Server` | `PPPoE User Name`, `Your ISP provided ... for PPPoE` |
| Network role | settings/flash utility plus network interface config | PPPoE variant of the same utility |

**[derived]** `FM_UTL` = flash-memory/network utility library (the `fmMng` module name), with
`nt*` network-interface code; `FM_UTL_PPPOE` is the PPPoE build. Both are SH-4 code.

Loader evidence [observed]: `0x0C0108E4` writes `{1, "BBA", "FM_UTL_PPPOE.BIN", 0}` into a
descriptor at `0x8C28582C`. The exact string `FM_UTL.BIN` does **not** occur in `1ST_READ.BIN`;
only `FM_UTL_PPPOE.BIN` is referenced by name. Whether the modem path loads `FM_UTL.BIN` through
a different table, or the retail build only uses the PPPoE variant, is **not yet proven** — that
is a Milestone 3 task.

### FM_UTL loading chain (documented, needs Ghidra confirmation)

The observed call chain for loading FM_UTL_PPPOE.BIN:

1. `0x0C010080` (real `main`): checks `0x8C28582C == 1`, then calls Katana loader at `0x8C1D92DA` with `"maigo.bin"`
2. `0x0C0108E4`: builds descriptor `{1, "BBA", "FM_UTL_PPPOE.BIN", 0}` at `0x8C28582C`; referenced from literal at `0x0C1CC6D0`
3. `0x8C1D92DA`: Katana dynamic library loader (LoadLibrary-style)
4. `0x8C1D8A4A` / `0x8C1D8B22`: Katana symbol resolution entries

**Unknown**: whether `0x0C0108E4` is called before or after `maigo.bin` loading, whether the same
loader loads `FM_UTL_PPPOE.BIN` after `maigo.bin`, and whether `FM_UTL.BIN` (modem variant) is
ever loaded at all. Requires Ghidra analysis of the call graph around `0x0C0108E4` and
`0x0C010080`.

**[observed]** `0x0C1E95A4..0x0C1E95C6` — expansion device probe routine (same in `1ST_READ.BIN`,
`FM_UTL.BIN`, and `FM_UTL_PPPOE.BIN`). Wrapper at `0x0C1E9750` switches to privileged mode and
calls `0x8C1EA11C`. Literal `0x53504147` ("GAPS") at `0x0C1E97C0` ties the probe to the BBA
bridge, not a generic memory read.

### `fs/MAIGO.BIN`

14,856-byte SH-4 module, string `MAIGO Ver.1.103 Copyright(c) SEGA ENTERPRISES, LTD., 1998,1999`.
The boot file references lowercase `maigo.bin`. **[inferred]** a Sega network/middleware overlay
loaded at runtime. Its exports and call sites are not yet mapped.

## Assets — PVR Texture and AFS Archive Formats (Milestone 4)

| File | Size | Header | Notes |
|---|---|---|---|
| `0GDTEX.PVR` | 131,104 | `GBIX` + `PVRT`; PVRT header size `0x208` (520 bytes) | GD-ROM texture (menu/logo), 256x256 |
| `BOMBER.AFS` | 688,472,064 | `AFS\0`, count `0x261f` (9759 entries) | archive; index at offset 8 |
| `BBA/BACKDROP.PVR` | 699,084 | `PVRT` 512x512 | network settings background |
| `BBA/CONTROL.PVR` | 32,800 | `PVRT` 256x128 | settings controls |
| `BBA/FONT.PVR` | 524,320 | `PVRT` 512x512 | settings font |
| `MAIGO.BIN` | 14,856 | raw SH-4 | see above |

### PVR texture format (observed from hex dump)

Both `0GDTEX.PVR` and `BBA/FONT.PVR` share the same structure:

| Offset | Size | Field | `0GDTEX.PVR` value | `BBA/FONT.PVR` value |
|---|---|---|---|---|
| 0 | 4 | Magic | `GBIX` | `GBIX` |
| 4 | 4 | Unknown | `0x00000008` | `0x00000008` |
| 8 | 4 | Magic | `PVRT` | `PVRT` |
| 12 | 4 | Header size | `0x00000208` (520) | `0x00000208` (520) |
| 16 | 4 | Pixel format? | `0x00000001` | `0x00000200` (512) |
| 20 | 4 | Unknown | `0x00000001` | `0x00000001` |
| 24 | 4 | Width | `0x00000100` (256) | `0x00000200` (512) |
| 28 | 4 | Height | `0x00000100` (256) | `0x00000200` (512) |
| 32+ | — | Palette/pixel data | zeros (palette?) | ARGB4444 palette data |

**[observed]** `BBA/FONT.PVR` palette data at offset 0x20 contains ARGB4444-like values (`ff 0f ff 0f ff bf ff bf ...`) — alpha=0xF, RGB values vary.

**[derived]** PVR pixel format `0x01` at offset 16 may correspond to a Dreamcast texture format (possibly ARGB4444 or palette-based). `0x0200` at offset 16 in FONT.PVR may be width encoded differently. Format decoding needed — do not assume linear RGBA.

**[derived]** Palette data follows the PVRT header (after offset 0x208 = 520 bytes). `0GDTEX.PVR` has zeros in the palette region (may be a direct/textured format without palette), `FONT.PVR` has actual palette data.

### AFS archive format (observed from hex dump)

| Offset | Size | Field | Value |
|---|---|---|---|
| 0 | 4 | Magic | `AFS\0` |
| 4 | 4 | Entry count | `0x0000261f` (9759) |
| 8+ | 8 per entry | Entry: offset (4 bytes LE) + size (4 bytes LE) | first entry: offset=0x00080000 (524,288), size=0x000606e0 (395,488) |

**[observed]** First entry at file offset 8: offset=`0x00080000` (524,288), size=`0x000606e0` (395,488 bytes). Second entry: offset=`0x000e0800` (927,744), size=`0x0002d5f0` (185,840 bytes). Archive is 688,472,064 bytes total.

**[derived]** AFS entries are not necessarily contiguous — entry 1 starts at 927,744 while entry 0 ends at 919,776 (gap of ~8KB). Entries may overlap or be sparse.

**[unknown]** Which AFS entries are code overlays (SH-4 executables) vs assets (PVR textures, audio). Needs AFS index parsing and entry header inspection.

## Kage Protocol — detailed string evidence from disassembly

The following strings were found in the `1ST_READ.BIN.TXT` Ghidra export at the listed addresses:

### Login/Authentication
| String | Ghidra addr | Link addr | Implied role |
|---|---|---|---|
| `CKageApp` | `0x0017869c` | `0x0C17869c` | Kage client application class |
| `kkLoginClient()` | `0x0C178964` | — | Login client entry point |
| `"CKageApp:: Failed LoginToKage."` | `0x001786bc` | `0x0C1786bc` | Login failure path |
| `"CKageApp:: Failed LogoutFromKage."` | `0x001786dc` | `0x0C1786dc` | Logout path |
| `"CKageApp:: Unkown Subkey %d Request ..."` | `0x00178718` | `0x0C178718` | Subkey handler |
| `"ChatControlUnit() not yet implimented."` | `0x0C178750` | — | Chat not implemented |
| `"CKageApp: Login Faile KK_NOT_FIND_GA..."` | `0x00178b04` | `0x0C178b04` | Game server not found |
| `"CKageApp: Login Faile KK_INVALID_TOK..."` | `0x00178b34` | `0x0C178b34` | Invalid token |
| `"CKageApp: Login Faile KK_INVALID_LOG..."` | `0x00178b5c` | `0x0C178b5c` | Invalid login |
| `"CKageApp: Login Faile KK_TIME_OUT_LO..."` | `0x0C178b84` | `0x0C178b84` | Login timeout |
| `"CKageApp: Login Faile Bad User-Name."` | `0x0C178bb0` | `0x0C178bb0` | Bad username |
| `"CKageApp: Login Faile User Age was u..."` | `0x0C178bd8` | `0x0C178bd8` | Age validation |
| `"CKageApp: Login Faile call kkLoginCl..."` | `0x0C178c08` | `0x0C178c08` | Login client call failure |
| `"Completed LoginToServer on UserID %d."` | `0x0C178db4` | `0x0C178db4` | Login complete |
| `"Fail LoginToServer Request."` | `0x0C178ddc` | `0x0C178ddc` | Login request fail |

### Lobby/Room
| String | Ghidra addr | Implied role |
|---|---|---|
| `CLobby` | `0x0C17a45c` | Lobby state object |
| `CGameRoom` | `0x0C17987c` | Game room state object |
| `"LOBBY LISTED CKageApp::Kage_Lobby_Li..."` | `0x0C1789dc` | Lobby list query |
| `"LOBBY LISTED CKageApp::Kage_Lobby_Jo..."` | `0x0C178a08` | Lobby join |
| `"QUERY ATTRIBUTE CKageApp::Kage_Lobby..."` | `0x0C178a34` | Lobby attribute query |
| `"QUERY USERIN CKageApp::Kage_Lobby_Jo..."` | `0x0C178a64` | Lobby user join |
| `"CKageApp:: Do not use before CNgnPPP..."` | `0x0C178a90` | PPP dependency check |

### Network stack / modem
| String | Ghidra addr | Implied role |
|---|---|---|
| `CNgnPPP` | — | NexGenPPP stack class |
| `NexGenPPP Ver.1.2` | `0x0C18c154` | PPP version string |
| `NexGenPPPoE Ver.1.2` | `0x0C18bfb8` | PPPoE version string |
| `"Probing for an external modem..."` | `0x0C1794d8` | Modem probe |
| `"BBA Network Disconnected ...!!!"` | `0x0C17976c` | BBA disconnect |
| `"Could not initialise the modem script"` | `0x0C1790e8` | Modem init failure |
| `"No dial tone detected..."` | `0x0C179110` | Modem dial tone |
| `"No answer..."` | `0x0C179188` | Modem no answer |

### Expected login flow (needs Ghidra verification)
1. `main` (`0x0C010080`) initializes network stacks (PPP/PPPoE via `FM_UTL_PPPOE.BIN`)
2. `CKageApp` constructed, `kkLoginClient()` called to connect to `master.bomberman-hudson.games.sega.net` (`0x0C181180`)
3. Login credentials sent, session established
4. `CLobby` / `CGameRoom` objects created for lobby/room management
5. `CBattleClient` handles in-game synchronization
6. `SendFastToServer` / `MapSendToServer` send game packets during matches

**Unknown (Milestone 3 tasks):**
- Which function calls `kkLoginClient()` and when (main menu? network settings screen?)
- How `CNgnPPP`/`NexGenPPP` initialize the modem/BBA
- Packet formats for `SendFastToServer`/`MapSendToServer`
- Battle synchronization protocol (`CBattleClient`)
- Whether `FM_UTL.BIN` (modem) vs `FM_UTL_PPPOE.BIN` (BBA) changes the login flow

## Ghidra task list for Milestones 3 and 4

**Networking (Milestone 3):**
- [ ] Name `0x0C010080` (main) and trace its call to `0x8C1D92DA` (Katana loader) for `maigo.bin`
- [ ] Name `0x0C0108E4` (FM_UTL descriptor builder) and trace who calls it
- [ ] Find where `CKageApp`, `kkLoginClient()`, `CNgnPPP`, `CLobby`, `CGameRoom`, `CBattleClient` are instantiated
- [ ] Trace `SendFastToServer`/`MapSendToServer` call sites for packet format
- [ ] Determine if `FM_UTL.BIN` (modem) is ever loaded vs only `FM_UTL_PPPOE.BIN` (BBA)
- [ ] Map `0x0C18164C` (master host string) references to the login connect function

**Assets (Milestone 4):**
- [ ] Parse AFS index at `0x00000008` in `BOMBER.AFS` to list all 9,759 entries
- [ ] Identify which AFS entries are code overlays (SH-4 executables) vs assets (PVR textures, audio)
- [ ] Decode PVR pixel format from `0GDTEX.PVR` header (`GBIX` + `PVRT`, size `0x208`)
- [ ] Determine if PVR textures are twiddled, VQ-compressed, or linear RGBA

