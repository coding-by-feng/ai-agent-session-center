# Known Issues & Guardrails

## Architecture Guardrails

- **Never mutate session objects** — always create new copies via spread/new Map
- **Never use HTTP-only hook transport** — file-based MQ is primary, HTTP is fallback only
- **Never block the hook script** — all processing must be in background subshell (`& disown`)
- **Never hardcode port 3333** — always read from config/env/CLI flag
- **Never modify `~/.claude/settings.json` without atomic write** (write-to-temp + rename)
- **Server imports use `.js` extensions** — required for NodeNext module resolution with tsx

## Approval Detection Limitations

- Auto-approved long-running commands (npm install, builds) briefly show as "approval" for ~8s until PostToolUse clears
- `hasChildProcesses` check (via `pgrep -P`) mitigates but doesn't eliminate false positives
- PermissionRequest event (medium+ density) is the reliable signal — prefer it over heuristics

## Session Matching Risks

- Priority 2 (workDir match) can misfire if two sessions share the same directory
- Priority 4 (PID parent check) is unreliable across shells
- Always prefer higher-priority matching strategies

## Performance Considerations

- `apiRouter.ts` is the largest server file (~1000+ lines) — consider splitting if it grows further
- 3D scene (Three.js) is the heaviest frontend component — lazy-load when possible
- WebSocket ring buffer holds 500 events — sufficient for reconnect replay but not full history
- MQ file truncated at 1MB — event ordering is preserved but old events are lost

## Testing Gaps

- Server tests are a mix of `.js` (legacy) and `.ts` (newer) — prefer `.ts` for new tests
- E2E tests exist but may need Playwright browser install: `npx playwright install`
- No automated integration tests for the hook bash script pipeline

## Security Notes

- SSH terminal creation validates against shell metacharacter injection (Zod + regex)
- File browser API uses `resolveProjectPath()` to prevent directory traversal
- Auth tokens are in-memory only (no persistent token storage on server)
- Hook scripts run with user's shell permissions — no privilege escalation
