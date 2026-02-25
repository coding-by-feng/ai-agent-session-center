# Contributing to AI Agent Session Center

Thanks for your interest in contributing! This guide will help you get started.

## Getting Started

1. **Fork the repository** and clone your fork:
   ```bash
   git clone https://github.com/<your-username>/ai-agent-session-center.git
   cd ai-agent-session-center
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the dev server**:
   ```bash
   npm run dev
   ```
   This starts both the Vite dev server (frontend HMR) and the Express backend with `tsx watch`.

4. **Run tests** to make sure everything works:
   ```bash
   npm test
   ```

## Development Workflow

1. Create a branch from `main`:
   ```bash
   git checkout -b feat/your-feature
   ```

2. Make your changes following the conventions below.

3. Run checks before committing:
   ```bash
   npm run typecheck   # TypeScript type checking
   npm run lint        # ESLint
   npm test            # Vitest (400+ tests)
   ```

4. Commit using [conventional commits](https://www.conventionalcommits.org/):
   ```
   feat: add new session filter
   fix: prevent duplicate queue entries
   refactor: extract approval detection logic
   docs: update troubleshooting section
   test: add tests for session matcher
   chore: bump dependencies
   ```

5. Open a pull request against `main`.

## Project Structure

- **`server/`** — Express 5 backend (ESM, TypeScript via tsx)
- **`src/`** — React 19 frontend (Vite, TypeScript)
- **`hooks/`** — Bash hook scripts and installers
- **`test/`** — Server-side tests
- **`src/**/*.test.{ts,tsx}`** — Frontend tests (colocated)

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

## Code Conventions

### General
- ESM throughout (`import`/`export`)
- Immutable updates — never mutate objects, always spread
- Small files (200-400 lines typical, 800 max)
- Functions under 50 lines

### Backend
- Server imports use `.js` extensions (NodeNext resolution)
- Zod for request validation
- JSON responses: `{ success: true, data }` or `{ success: false, error }`
- Use the `log` utility, not `console.log`

### Frontend
- Function components only
- Zustand for state management (immutable via spread)
- CSS Modules for styling (no Tailwind, no inline styles)
- Path alias: `@/` maps to `src/`

### Testing
- Vitest for unit and integration tests
- Playwright for E2E tests
- Write tests in `describe/it` blocks
- Target 80%+ coverage for new code

## Areas Where Help Is Welcome

- **More CLI integrations** — OpenCode, Cursor, Windsurf, or any agentic framework
- **Remote monitoring** — dashboard accessible from other machines
- **Windows support** — testing and improving the PowerShell hook variant
- **Community themes** — new 3D scene themes and robot models
- **Mobile UX** — responsive improvements for smaller screens
- **Documentation** — tutorials, guides, translations

## Reporting Issues

When reporting bugs, please include:
- Node.js version (`node -v`)
- Operating system
- Which AI CLI(s) you're using
- Steps to reproduce
- Any relevant error output from `npm run debug`

## Questions?

Open an issue with the `question` label, or start a discussion in the repository.
