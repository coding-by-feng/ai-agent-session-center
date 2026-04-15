# Workflow Rules

## Feature Implementation Flow

1. **Plan** (`/plan`) for multi-file features or architectural changes
2. **TDD** (`/tdd`) — write Vitest tests first, then implement
3. **Implement** — follow conventions in backend.md / frontend.md
4. **Review** — use `code-reviewer` agent after writing code
5. **Security** — use `security-reviewer` when touching auth, SSH, hooks, or API endpoints

## Agent Triggers (automatic, no user prompt needed)

| Trigger | Agent |
|---------|-------|
| New feature spanning 3+ files | `planner` |
| Code just written/modified | `code-reviewer` |
| Bug fix or new feature | `tdd-guide` |
| Build fails | `build-error-resolver` |
| Modifying `authManager.ts`, SSH, or hook scripts | `security-reviewer` |

## Testing Requirements

- **Framework**: Vitest (unit/integration), Playwright (E2E)
- **Server tests**: `test/*.test.{js,ts}` — run with `npm test`
- **Frontend tests**: `src/**/*.test.{ts,tsx}` — run with `npm test`
- **E2E tests**: run with `npm run test:e2e`
- **Coverage**: `npm run test:coverage` (target 80%+)
- **Test style**: `describe/it` blocks, `beforeEach/afterEach` for setup, `vi.mock()` for mocking

## Commit Conventions

- Format: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci)
- No co-author attribution (disabled globally)
- Lint before commit: `npm run lint`
- Type check: `npm run typecheck`

## Development Commands

```bash
npm run dev          # Vite + tsx watch (HMR)
npm run build        # Production build
npm test             # Vitest run
npm run test:watch   # Vitest watch mode
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint src/
npm run format       # Prettier
```
