# Instructions for agents working on this repository

Read `docs/PLAN.md` and `docs/GAME-INTERNALS.md` first. This is a port repository built on the
dreamcomp framework at `~/Tools/dreamcomp` (override with `$DREAMCOMP_DIR`).

## Hard rules

- **No game data, ever.** No disc images, extracted executables, PVR/AFS assets, generated code
  (`build/`, `game/extracted/`), Ghidra databases, VMU/BIOS images, or derived asset dumps.
  `.gitignore` enforces the common cases; run `python ~/Tools/dreamcomp/tools/audit.py assets
  --repo .` before committing.
- Original files live in `~/Tools/BombermanOnline-private` and must not be modified or deleted.
- Do not publish or push this repository without explicit authorization.
- Never hand-edit generated code under `build/game/gen/`; change the TOML, hooks, or translator.
- Changes under the dreamcomp `engine/` are a last resort and must be recorded in
  `~/Tools/dreamcomp/docs/engine-changes.md` in the same change.
- Do not install system-wide dependencies (no sudo, no Homebrew, no full Vulkan SDK).
- One verified change at a time. State plainly what was **not** verified.

## Workflow

```sh
tools/dc.sh doctor
tools/dc.sh setup . --disc "/path/to/disc.chd"
tools/dc.sh build . --headless        # 8 GB machine: headless first
tools/dc.sh report . --frames 600
tools/dc.sh shots . --at 120,300,600
```

Ghidra project (outside the repo): `~/Tools/BombermanOnline-analysis/ghidra`, project name
`BombermanOnline`, language `SuperH4:LE:32:default`, raw base `0x0C010000`. Analysis helper scripts
live in `~/Tools/BombermanOnline-analysis/scripts`. REA is connected through OpenCode; it currently
cannot import SH-4 raw binaries itself (its raw-binary architecture list excludes SH-4), so Ghidra
headless is the primary disassembler/decompiler and REA is used for supported artifact inspection.

## Documentation contract

- Game facts -> `docs/GAME-INTERNALS.md` with address/offset, evidence, confidence.
- Phase evidence -> `docs/findings/phase-NN.md`.
- Toolchain facts -> `docs/PORTING.md`.
- Status -> `docs/PLAN.md` (verified checkpoints table).
- Mark inference as inference. Keep negative results.

## Style

Direct, technical, tables, short sections. Distinguish implemented+tested, implemented+untested,
partial, investigated-only, and not investigated.
