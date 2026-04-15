Release a new Electron build to GitHub. Follow these steps in order:

1. **Bump version** — Read `package.json`, increment the patch version (e.g. 2.10.4 → 2.10.5), and write it back.

2. **Commit** — Stage ALL modified files (`git add` the specific changed files). Commit with message format: `feat: <short summary of changes>` or `fix: <summary>` depending on the nature of the changes. Review the diff to write an accurate commit message.

3. **Build** — Run `npm run electron:build`. If it fails, diagnose and fix the error, then retry.

4. **Push** — Run `git push` to push the commit to remote.

5. **Release** — Create a GitHub release using `gh release create`:
   - Tag: `v<version>` (e.g. `v2.10.5`)
   - Title: `v<version>`
   - Attach both built artifacts from `dist/`:
     - `AI Agent Session Center-<version>-arm64.dmg`
     - `AI Agent Session Center-<version>-arm64-mac.zip`
   - Release notes should include:
     - `## What's New` section with categorized changes (Features, Bug Fixes, Improvements)
     - `### Downloads` section listing the DMG and ZIP filenames
     - Footer note about Gatekeeper bypass (not code-signed)
   - Use the diff since the last release tag to determine what changed.

6. **Report** — Print the release URL when done.
