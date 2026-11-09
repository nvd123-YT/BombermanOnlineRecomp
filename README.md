# Bomberman Online — native recompilation

A native C/C++ recompilation of **Bomberman Online** (Sega Dreamcast, USA, MK-51065 V1.004),
built on [dreamcomp](https://github.com/phobos665/dream-recomp)-style static SH-4 recompilation,
with working original online multiplayer via DCNet and a cross-platform Electron launcher.

The original game is © SEGA / HUDSON SOFT. **This repository contains no game data.** You must
supply your own disc image (`.chd`).

## What is here

| Path | Purpose |
|---|---|
| `game/bomberman_online.toml` | Measured game config for `dream-translate` (disc SHA-1, load/link address) |
| `src/bomberman_online.cpp` | Port registration and device/MMIO handlers |
| `game/bindings.txt` | Documented default keyboard/gamepad input bindings |
| `tools/launcher/` | Cross-platform Electron launcher (disc browse, Play, online, resolution, controller remap, logs) |
| `tools/dc.sh` | Run dreamcomp's CLI with the local toolchain environment |
| `tools/env.sh` | Local paths (dreamcomp, Java, Ghidra, libchdr) — no system installs |
| `docs/GAME-INTERNALS.md` | Reverse-engineered facts, with evidence and confidence |
| `docs/PLAN.md` | Milestones, gates, verified checkpoints |

## Build

Prerequisites: CMake 3.24+, Ninja, a C++20 compiler, Python 3, and an extracted boot file from your
own disc. The dreamcomp engine is vendored at `./dreamcomp`; nothing else needs checking out.
A windowed build also needs SDL3 and Vulkan (the Vulkan SDK provides `glslc`); on macOS, MoltenVK
and a `glslc` on `PATH` (or the repository's libshaderc-driven shim) are enough.

```sh
tools/dc.sh setup . --disc "/path/to/Bomberman Online (USA).chd"
tools/dc.sh build .            # headless-capable build
tools/dc.sh report . --frames 600
```

`setup` reads the boot binary straight from your image. `.gdi` and `.cue` need nothing extra; for
`.chd`, the vendored libchdr is built once on first use so no system package is required.

The game executable is generated into `build/game/bomberman-online` and is never committed. The
generated SH-4 code is compiled as eight translation units in parallel; the build prints a
heartbeat with the number of parts finished so a long first build does not look hung.

## Launcher

The Electron launcher replaces the old Tk UI. Build and run it:

```sh
cd tools/launcher
npm ci
npm start                      # dev mode
npm run selftest               # verify UI renders on all platforms
npm run package                # electron-builder: .dmg/.zip (macOS), .exe/.zip (Windows), .AppImage/.deb/.tar.gz (Linux)
```

The launcher handles disc selection, Play/Headless/Build/Stop, resolution presets + scale slider,
aspect (native/wide), vSync/fullscreen/FPS/sound, online enable/DCNet server/port, TCP reachability
test, controller test, remap editor, streaming logs, and settings persistence.

**First run:** choose your disc image and press **Play**. If the game has never been built here, the
launcher extracts the boot binary from your disc (`dc.py setup`), builds the game with visible
progress, then launches it. Later Play presses start the existing binary immediately; **Build**
forces a rebuild after a source change. Nothing from the disc is copied into the app bundle — the
extracted boot binary and the executable stay in the writable app data directory.

## Online (DCNet)

Original online multiplayer is implemented over the BBA + DCNet:

- **Discovery:** UDP to `dcnet.flyca.st:7655`, picks an access point (US East, Europe, South America, US West)
- **TCP:** framed `DCNET\x01` prolog + 2-byte LE length Ethernet frames to the access point
- **DHCP:** Discover → Offer → Request → ACK (assigns IP via DCNet)
- **Flash:** seeded with Flycast's ISP + BBA blocks (netmask `0xFFFFFF00`, IP 0 = DHCP, valid CRCs)

To play online: create a character in Extras Box first (saves to `.dreamcomp/bomberman.vmu`), then enable
online in the launcher and enter online mode in-game.

## Status

| Area | State |
|---|---|
| Disc identification, boot binary, first translation | implemented and verified |
| Native build | headless + windowed builds verified (macOS via MoltenVK) |
| Expansion-device probes | all five mapped as absent devices; `unmapped memory accesses: 0` |
| Translation coverage | `untranslated call targets: 0` after merging modem/BBA function seeds |
| Audio | larger circular buffer (93 ms) + rate control; stuttering resolved |
| BBA / DCNet online | RTL8139 implemented, DCNet transport + DHCP handshake working |
| Game reached title screen | confirmed via scripted input |
| Character creation | VMU `.dreamcomp/bomberman.vmu` contains valid `BOMBERONLINE` save |
| Online connection | TCP established to DCNet access point; DHCP Offer received |
| Launcher | Electron: disc browse, Play, online, resolution, controller remap, logs, settings |
| Packaging | electron-builder: macOS .dmg/.zip, Windows .exe/.zip, Linux .AppImage/.deb/.tar.gz |
| CI | GitHub Actions: nightly builds on macOS/Windows/Linux + tag-triggered releases |
| Menu rendering | suspected stretch; true widescreen TBD |

## Repository rules

- **No game data committed:** `.chd`, `.vmu`, `.PVR`, `.AFS`, etc. are all in `.gitignore`
- **No credentials, no Ghidra DBs**
- **No push/publish without authorization**
- Nightly releases are built automatically at 00:00 UTC; tag a commit with `v*` for a formal release