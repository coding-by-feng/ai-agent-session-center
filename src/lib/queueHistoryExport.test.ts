import { describe, it, expect } from 'vitest';
import {
  serializeEntries,
  parseImportFile,
  defaultExportFilename,
  EXPORT_SCHEMA,
  EXPORT_VERSION,
  MAX_IMPORT_SIZE,
} from './queueHistoryExport';
import type { QueueHistoryEntry } from '@/stores/queueHistoryStore';

function mkEntry(p: Partial<QueueHistoryEntry> = {}): QueueHistoryEntry {
  return {
    id: p.id ?? 1,
    alias: p.alias ?? null,
    item: p.item ?? {
      id: 0,
      sessionId: '',
      position: 0,
      createdAt: 1_700_000_000_000,
      text: 'hello',
      type: 'once',
    },
    sourceSessionTitle: p.sourceSessionTitle ?? null,
    sourceSessionId: p.sourceSessionId ?? null,
    usedCount: p.usedCount ?? 0,
    createdAt: p.createdAt ?? 1_700_000_000_000,
    lastUsedAt: p.lastUsedAt ?? null,
  };
}

describe('serializeEntries', () => {
  it('produces a valid envelope with schema + version', () => {
    const json = serializeEntries([mkEntry()]);
    const parsed = JSON.parse(json);
    expect(parsed.schema).toBe(EXPORT_SCHEMA);
    expect(parsed.version).toBe(EXPORT_VERSION);
    expect(parsed.count).toBe(1);
    expect(Array.isArray(parsed.entries)).toBe(true);
  });

  it('strips the database id from every entry', () => {
    const entries = [
      mkEntry({ id: 7 }),
      mkEntry({ id: 8 }),
    ];
    const parsed = JSON.parse(serializeEntries(entries));
    for (const e of parsed.entries) {
      expect(e).not.toHaveProperty('id');
    }
  });

  it('preserves source breadcrumb and usage counts', () => {
    const entries = [
      mkEntry({
        sourceSessionTitle: 'agent-manager',
        sourceSessionId: 'sess-1',
        usedCount: 12,
        lastUsedAt: 1_700_000_100_000,
      }),
    ];
    const parsed = JSON.parse(serializeEntries(entries));
    expect(parsed.entries[0].sourceSessionTitle).toBe('agent-manager');
    expect(parsed.entries[0].sourceSessionId).toBe('sess-1');
    expect(parsed.entries[0].usedCount).toBe(12);
    expect(parsed.entries[0].lastUsedAt).toBe(1_700_000_100_000);
  });

  it('emits an ISO 8601 exportedAt', () => {
    const parsed = JSON.parse(serializeEntries([]));
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('preserves the alias when present and omits it when absent', () => {
    const parsed = JSON.parse(
      serializeEntries([mkEntry({ id: 1, alias: 'nightly lint loop' }), mkEntry({ id: 2 })]),
    );
    expect(parsed.entries[0].alias).toBe('nightly lint loop');
    expect(parsed.entries[1].alias).toBeUndefined();
  });
});

describe('parseImportFile', () => {
  it('round-trips a serialized file', () => {
    const original = [
      mkEntry({ id: 1, sourceSessionTitle: 'A', usedCount: 3 }),
      mkEntry({ id: 2, sourceSessionTitle: 'B', usedCount: 0 }),
    ];
    const text = serializeEntries(original);
    const result = parseImportFile(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.count).toBe(2);
    expect(result.file.entries[0].sourceSessionTitle).toBe('A');
    expect(result.file.entries[1].usedCount).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('round-trips the alias and ignores a blank one', () => {
    const text = serializeEntries([
      mkEntry({ id: 1, alias: 'review + lint + test' }),
      mkEntry({ id: 2, alias: '   ' }),
    ]);
    const result = parseImportFile(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.entries[0].alias).toBe('review + lint + test');
    // A whitespace-only alias is treated as no alias.
    expect(result.file.entries[1].alias).toBeUndefined();
  });

  it('rejects oversized files', () => {
    const r = parseImportFile('{}', MAX_IMPORT_SIZE + 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('too-large');
  });

  it('rejects malformed JSON', () => {
    const r = parseImportFile('not json');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('invalid-json');
  });

  it('rejects wrong schema', () => {
    const r = parseImportFile(JSON.stringify({ schema: 'something-else', version: 1, entries: [] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('wrong-schema');
  });

  it('rejects newer version', () => {
    const r = parseImportFile(
      JSON.stringify({ schema: EXPORT_SCHEMA, version: 99, entries: [] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('newer-version');
  });

  it('rejects when entries is not an array', () => {
    const r = parseImportFile(
      JSON.stringify({ schema: EXPORT_SCHEMA, version: 1, entries: 'oops' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('malformed');
  });

  it('rejects top-level arrays', () => {
    const r = parseImportFile(JSON.stringify([]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('malformed');
  });

  it('silently skips entries missing required fields (counts in summary)', () => {
    const text = JSON.stringify({
      schema: EXPORT_SCHEMA,
      version: EXPORT_VERSION,
      entries: [
        // valid
        { item: { text: 'hi', createdAt: 1 }, createdAt: 1, usedCount: 0 },
        // missing item
        { createdAt: 1, usedCount: 0 },
        // item missing text
        { item: { createdAt: 1 }, createdAt: 1, usedCount: 0 },
        // item with empty text
        { item: { text: '', createdAt: 1 }, createdAt: 1, usedCount: 0 },
        // item missing createdAt
        { item: { text: 'hi' }, createdAt: 1, usedCount: 0 },
      ],
    });
    const r = parseImportFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.count).toBe(1);
    expect(r.skipped).toBe(4);
  });

  it('falls back to item.createdAt when entry.createdAt is missing', () => {
    const text = JSON.stringify({
      schema: EXPORT_SCHEMA,
      version: EXPORT_VERSION,
      entries: [
        { item: { text: 'hi', createdAt: 1_700_000_000_000 }, usedCount: 0 },
      ],
    });
    const r = parseImportFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.entries[0].createdAt).toBe(1_700_000_000_000);
  });

  it('heals a loop entry with missing/invalid intervalMs to the 60s default', () => {
    const text = JSON.stringify({
      schema: EXPORT_SCHEMA,
      version: EXPORT_VERSION,
      entries: [
        // missing intervalMs
        { item: { text: 'a', createdAt: 1, type: 'loop' }, createdAt: 1, usedCount: 0 },
        // zero intervalMs
        { item: { text: 'b', createdAt: 1, type: 'loop', intervalMs: 0 }, createdAt: 1, usedCount: 0 },
        // negative intervalMs
        { item: { text: 'c', createdAt: 1, type: 'loop', intervalMs: -5 }, createdAt: 1, usedCount: 0 },
      ],
    });
    const r = parseImportFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Sanitize (not reject) — the user's prompt text is the valuable part.
    expect(r.file.entries).toHaveLength(3);
    for (const e of r.file.entries) {
      expect(e.item.type).toBe('loop');
      expect(e.item.intervalMs).toBe(60_000);
    }
  });

  it('preserves a valid loop intervalMs unchanged', () => {
    const text = JSON.stringify({
      schema: EXPORT_SCHEMA,
      version: EXPORT_VERSION,
      entries: [
        { item: { text: 'a', createdAt: 1, type: 'loop', intervalMs: 300_000 }, createdAt: 1, usedCount: 0 },
      ],
    });
    const r = parseImportFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.entries[0].item.intervalMs).toBe(300_000);
  });
});

describe('defaultExportFilename', () => {
  it('formats as queue-history-YYYY-MM-DD.json', () => {
    const name = defaultExportFilename(new Date('2026-05-28T09:42:00Z'));
    expect(name).toMatch(/^queue-history-2026-05-2[78]\.json$/);
  });

  it('pads single-digit months and days', () => {
    const name = defaultExportFilename(new Date(2026, 0, 3));
    expect(name).toBe('queue-history-2026-01-03.json');
  });
});
