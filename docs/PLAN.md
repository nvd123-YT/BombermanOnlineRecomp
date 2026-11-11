# Bomberman Online Recomp — Development Plan

This file tracks work that is still relevant to the current repository. Historical investigations and completed fixes belong in the engine changelog, not in the active blocker list.

## Current state

- The game boots and is playable in the windowed build.
- Online play is implemented through the emulated broadband adapter and DCNet. Modem and PPPoE modes are not implemented; the launcher marks them as planned.
- VMU persistence is implemented.
- The launcher supports resolution/aspect settings, controller testing and remapping, online configuration, diagnostics through logs, and release updates.
- GitHub Actions builds macOS, Linux, and Windows packages. The game-data validation step checks file extensions without case sensitivity.
- The homepage is connected to the community statistics Worker. Session totals are intentionally used as the all-time player-activity measure; unique-player and daily counts remain separate metrics.

## Remaining work

| Area | Current status | Next step |
|---|---|---|
| Main-menu rendering | Several renderer and YUV 4:2:2 fixes are recorded in `dreamcomp/docs/engine-changes.md` through 2026-11-07. Do not assume the old flicker diagnosis is still current. | Verify the current build in the windowed game. If artifacts remain, capture a focused trace and investigate only the reproduced issue. |
| PVR/AFS asset decoding | Format research exists; broader native asset decoding is not complete. | Continue only when a concrete asset-loading need is identified. |
| Ghidra function naming | Networking and startup function names remain incomplete in the research notes. | Recreate/import the analysis project if needed, then export verified symbols. |
| Modem / PPPoE | Not implemented; BBA is the supported online adapter. | Keep unavailable in the launcher until a real implementation exists. |
| Statistics operations | Worker and dashboard integration are present. | Verify scheduled collection, D1 schema/secrets, and visible warning state after deployment changes. |

## Development priorities

1. Preserve the currently working game and DCNet path.
2. Fix reproducible launcher, input, packaging, and data-safety bugs before expanding emulation scope.
3. Keep release artifacts attached to GitHub Releases and verify platform builds before treating a release as complete.
4. Update this plan when a task is completed; keep detailed historical experiments in the engine changelog.

## Historical notes

Older investigations into menu flicker, Ghidra project corruption, generated code size, and renderer sort order are retained in commit history and the engine changelog. They are not automatically active blockers.
