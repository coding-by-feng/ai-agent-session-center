---
name: electron-release
description: Prepare and publish a new macOS arm64 Electron release for this repository. Use only when the user explicitly invokes $electron-release or directly asks to version, build, commit, push, and publish an Electron release to GitHub.
---

# Release Electron Build

Release the reviewed repository changes as the next patch version. This workflow
changes version files, creates a commit, pushes it, and creates a public GitHub
release, so keep every step scoped and verifiable.

## Safety Rules

- Treat explicit invocation or a direct release request as authorization for
  this release sequence, not for unrelated local files.
- Inspect the worktree before changing it. Preserve unrelated edits and never
  use `git add -A` or `git add .`.
- Exclude local-only state such as `.codex/audit/`, root-level generated
  bundles, screenshots, caches, credentials, and environment files.
- Stop for user direction when a dirty file's inclusion is ambiguous or the
  current branch, remote, or release target is unexpected.
- Never delete or overwrite a remote release, tag, or pushed commit as automatic
  error recovery.

## 1. Preflight

1. Resolve the Git root and read the applicable `AGENTS.md` and `CLAUDE.md`.
2. Inspect `git status --short`, the complete relevant diff, the current
   branch, its upstream, and the configured GitHub remote.
3. Classify every changed and untracked file as release content, required
   version metadata, generated artifact, or unrelated local state. Record the
   exact paths intended for the commit.
4. Verify GitHub CLI authentication with `gh auth status`.
5. Refresh tags from the release remote and query the latest published release
   with `gh release list`. Do not rely only on potentially stale local tags.
6. Confirm that the next patch version and its `v<version>` tag do not already
   exist locally or on GitHub.

## 2. Version

1. Read the version from `package.json`.
2. Run `npm version patch --no-git-tag-version` so `package.json` and an
   existing `package-lock.json` advance together.
3. Verify the top-level versions match and inspect the version-file diff. Do not
   continue if the command changed dependencies or unrelated metadata.

## 3. Validate and Build

1. Run `npm run typecheck`.
2. Run targeted tests appropriate to the reviewed changes and any additional
   checks required by `AGENTS.md`.
3. Run `npm run electron:build`. Diagnose failures and apply only narrow fixes
   that remain inside the approved release scope; rerun affected checks after a
   fix.
4. Verify these non-empty artifacts for the new version:
   - `dist/AI Agent Session Center-<version>-arm64.dmg`
   - `dist/AI Agent Session Center-<version>-arm64-mac.zip`
5. Compute SHA-256 checksums for both artifacts.

Do not create the release commit when required validation or artifact checks
fail.

## 4. Commit and Push

1. Stage only the reviewed release-content paths and required version files by
   explicit filename.
2. Inspect `git diff --cached --stat` and the full staged diff for accidental
   local artifacts, secrets, unresolved placeholders, and missing release
   changes.
3. Choose `feat: <summary>` or `fix: <summary>` from the actual staged
   behavior and create one release commit.
4. Push the current branch to its expected upstream. Do not publish a GitHub
   release unless the push succeeds and the remote commit matches the local
   release commit.

## 5. Publish

1. Set the tag and title to `v<version>`.
2. Derive release notes from the latest published release through the new commit,
   cross-checking the reviewed working diff so no shipped change is omitted.
3. Include:
   - `## What's New` with only relevant Features, Bug Fixes, and Improvements
     subsections;
   - `### Downloads` listing the exact DMG and ZIP filenames;
   - the repository's Gatekeeper bypass note for the unsigned macOS build.
4. Create the GitHub release with `gh release create`, targeting the pushed
   release commit and attaching only the verified DMG and ZIP.
5. Verify the release with `gh release view`: confirm its URL, target commit,
   tag, and both downloadable assets.

If publishing fails after the commit was pushed, report the exact remote state
and retry only the failed release step when safe. Do not claim completion until
the release and both assets are visible on GitHub.

## Report

Return the version, commit hash, release URL, artifact filenames, checksums, and
validation results. Separately list any preserved dirty files that were excluded
from the release commit.
