# Frontend Conventions (React 19 + Vite 7)

## Components

- Function components only (no class components)
- `export default function ComponentName()` for page-level components
- Arrow functions for handlers: `const handler = useCallback(() => { ... }, [deps])`
- Early returns for conditional rendering
- Small, focused components — delegate to sub-components

## State Management (Zustand 5)

- Store pattern: `export const useXxxStore = create<XxxState>((set, get) => ({ ...state, ...actions }))`
- Immutability via spread: `set((s) => ({ sessions: new Map(s.sessions) }))`
- Use selectors to avoid over-subscriptions: `useSessionStore((s) => s.sessions)`
- `Map` for session collections (not arrays)

## Styling

- **CSS Modules** exclusively — no Tailwind, no inline styles
- File location: `src/styles/modules/ComponentName.module.css`
- Import as: `import styles from '@/styles/modules/ComponentName.module.css'`
- Usage: `className={styles.className}`
- Theme: dark navy (#0a0a1a), neon accents (cyan, orange, green, red, yellow, purple)

## Imports

- Path alias: `@/` maps to `src/`
- Explicit type imports: `import type { Session } from '@/types'`
- Order: React/external libs, then local stores/hooks/components, then CSS
- Types re-exported from `src/types/index.ts`

## Type Patterns

- Discriminated unions for status enums: `type SessionStatus = 'idle' | 'prompting' | ...`
- Interface hierarchies for domain objects (Session, PromptEntry, ToolLogEntry)
- Canonical types in `src/types/` shared by server and client

## Key Libraries

| Library | Purpose |
|---------|---------|
| `@react-three/fiber` + `drei` | 3D scene (cyberdrome, robots) |
| `zustand` | Global state |
| `@xterm/xterm` | Terminal emulation |
| `react-router` v7 | Client routing |
| `react-hook-form` + `zod` | Form handling + validation |
| `recharts` | Analytics charts |
| `dexie` | IndexedDB (browser persistence) |
| `react-markdown` + `rehype-highlight` | Markdown rendering |

## Package Manager

- npm (uses `package-lock.json`)
- Node >= 18 required
