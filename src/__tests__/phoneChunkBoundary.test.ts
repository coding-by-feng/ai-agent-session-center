// phoneChunkBoundary.test.ts — the phone's screens stay out of the desktop's entry chunk
// (AASC-31). Rollup puts every module reachable by STATIC imports from main.tsx in the entry,
// so one `import PhoneX from '@/components/mobile/PhoneX'` in an eager component ships the
// whole phone subtree to every desktop window. This walks that graph the way the bundler does
// (static imports and re-exports; `import()` and type-only imports don't count) and fails on
// any phone-only module it reaches. A phone-only piece is loaded with `lazy(() => import(...))`.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Phone-only modules outside components/mobile/. */
const PHONE_ONLY = [
  'components/session/QueueMoveSheet.tsx',
  'hooks/useSelectionIn.ts',
  'lib/phoneSuggestions.ts',
  'lib/queueImageAttach.ts',
  'lib/terminalCompose.ts',
  // The new phone app's navigation (AASC-39).
  'stores/phoneNavStore.ts',
  // The phone chat, its Changes and the composer's draft (AASC-41/44).
  'stores/chatStore.ts',
  'stores/changesStore.ts',
  'stores/composerDraftStore.ts',
];

/** Phone-only folders outside components/mobile/ (the new phone app, AASC-38/39). */
const PHONE_ONLY_DIRS = ['lib/chat/', 'styles/modules/mobile/'];

function resolveImport(from: string, request: string): string | null {
  const specifier = request.replace(/\?.*$/, ''); // `?url`, `?raw`
  let base: string;
  if (specifier.startsWith('@/')) base = resolve(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return null; // a package
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of SOURCE_EXTENSIONS) if (existsSync(base + ext)) return base + ext;
  throw new Error(`${relative(SRC, from)}: cannot resolve '${specifier}'`);
}

/** `import x from`, `import { a } from`, `export { a } from`, `export * from`, `import 'x'`. */
const FROM_CLAUSE = /^\s*(import|export)\s+([^;]*?)\s*from\s*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT = /^\s*import\s*['"]([^'"]+)['"]/gm;

/** A clause the compiler erases: `import type …`, or braces holding only `type X` specifiers. */
function typeOnly(clause: string): boolean {
  if (/^type\s/.test(clause)) return true;
  const braces = clause.match(/^\{([^}]*)\}$/);
  if (!braces) return false;
  const names = braces[1].split(',').map((s) => s.trim()).filter(Boolean);
  return names.length > 0 && names.every((n) => n.startsWith('type '));
}

function staticImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const m of source.matchAll(FROM_CLAUSE)) if (!typeOnly(m[2].trim())) specifiers.push(m[3]);
  for (const m of source.matchAll(SIDE_EFFECT)) specifiers.push(m[1]);
  return specifiers;
}

/** Every source file the entry reaches through static imports, as paths relative to src/. */
function entryGraph(): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(SRC, 'main.tsx')];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const rel = relative(SRC, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!/\.tsx?$/.test(file)) continue; // a stylesheet or asset: nothing further
    for (const specifier of staticImports(file)) {
      const target = resolveImport(file, specifier);
      if (target) queue.push(target);
    }
  }
  return seen;
}

describe('the desktop entry chunk', () => {
  const graph = entryGraph();

  it('reaches the components that host the phone screens (the walk itself works)', () => {
    for (const host of [
      'App.tsx',
      'routes/LiveView.tsx',
      'components/session/DetailPanel.tsx',
      'components/session/ConversationView.tsx',
      'components/session/QueueTab.tsx',
      'components/session/FloatingTerminalRoot.tsx',
      'components/terminal/TerminalContainer.tsx',
    ]) {
      expect(graph.has(host), host).toBe(true);
    }
  });

  it('statically imports no phone-only module', () => {
    const leaked = [...graph].filter((f) => f.startsWith('components/mobile/')
      || PHONE_ONLY.includes(f)
      || PHONE_ONLY_DIRS.some((dir) => f.startsWith(dir)));
    expect(leaked).toEqual([]);
  });

  it('lazy-loads the phone app: App.tsx picks it by screen size alone (AASC-48)', () => {
    const app = readFileSync(resolve(SRC, 'App.tsx'), 'utf8');
    expect(app).toMatch(/lazy\(\(\) => import\('@\/components\/mobile\/app\/PhoneAppFrame'\)\)/);
    expect([...graph].filter((f) => f.startsWith('components/mobile/app/'))).toEqual([]);
    // The "New design" switch it read until every phone had the app.
    expect([...graph].some((f) => f.includes('usePhoneUi'))).toBe(false);
  });

  it('keeps the phone-only stylesheets out of it too', () => {
    const phoneSheets = [...graph].filter((f) =>
      /styles\/modules\/(PhoneSession|PhoneExtras|PhoneLive|PhoneSuggestionBar|SessionDrawer|PhoneRooms)\.module\.css$/.test(f));
    expect(phoneSheets).toEqual([]);
  });
});
