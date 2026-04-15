# Backend Conventions (Express 5 + Node.js ESM)

## Module Style

- ESM throughout (`import`/`export`, `"type": "module"`)
- Named exports for functions, default export for routers
- Runtime: `tsx` (TypeScript execution without build step)
- Server files import with `.js` extension (NodeNext resolution): `import { x } from './module.js'`

## Express Routes

- Use `Router()` instance with explicit HTTP methods
- Normalize Express 5 query/param ambiguity with `str()` helper:
  ```typescript
  const str = (v: string | string[] | undefined, fallback = ''): string =>
    Array.isArray(v) ? v[0] ?? fallback : v ?? fallback
  ```
- Return JSON consistently: `res.json({ success: true, data })` or `res.status(4xx).json({ success: false, error: msg })`

## Input Validation

- Zod schemas for ALL API request bodies
- `validateBody<T>(req, res, schema)` helper returns parsed data or sends 400
- Shell metacharacter regex (`SHELL_META_RE`) blocks injection in SSH-related fields
- File path traversal prevention via `resolveProjectPath()`

## Error Handling

- `try-catch` with: `err instanceof Error ? err.message : String(err)`
- Log with context: `log.error('context', 'message')`
- Never expose stack traces to clients

## Logging

- Custom logger: `log.info()`, `log.warn()`, `log.error()`, `log.debug()`, `log.debugJson()`
- Format: `log.method('module-context', 'description')`

## Concurrency & Limits

- In-memory sliding window rate limiter for expensive endpoints
- `MAX_CONCURRENT_SUMMARIZE = 2`, `MAX_TERMINALS = 10`
- Background tasks via `setTimeout` / async, never block the event loop

## Coordinator Pattern

- `sessionStore.ts` delegates to focused sub-modules (sessionMatcher, approvalDetector, teamManager, processMonitor, autoIdleManager)
- Each sub-module has single responsibility
- Avoid growing any module into a monolith — extract when > 800 lines
