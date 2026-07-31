---
name: electron-build
description: Build and verify this repository's Electron distributables. Use when the user invokes $electron-build or asks to build, rebuild, package, or troubleshoot the macOS Electron app, DMG, or ZIP without publishing a release.
---

# Build Electron Distributables

Build the Electron app from the repository root and verify the versioned macOS
artifacts. Do not commit, push, tag, or publish as part of this skill.

## Workflow

1. Resolve the Git root and read the applicable `AGENTS.md` and `CLAUDE.md`.
2. Inspect `git status --short` and preserve every unrelated local change.
3. Confirm `package.json` defines `electron:build` and read its current
   version.
4. Run `npm run electron:build` and stream the output.
5. If the build fails, diagnose the first actionable error. Apply only a narrow,
   in-scope fix that does not overwrite existing work, then rerun the smallest
   relevant check before retrying the build. Report the blocker instead when a
   safe fix needs user direction, credentials, signing access, or a broader
   behavior change.
6. Verify that these non-empty artifacts exist for the package version:
   - `dist/AI Agent Session Center-<version>-arm64.dmg`
   - `dist/AI Agent Session Center-<version>-arm64-mac.zip`
7. Report success or failure, artifact paths and sizes, and any source changes
   made while resolving a build failure. Include SHA-256 checksums when the
   artifacts may be handed off or uploaded.

Do not treat an exit code of zero as sufficient if either expected artifact is
missing or empty.
