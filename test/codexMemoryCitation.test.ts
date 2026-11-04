import { describe, it, expect } from 'vitest';
import { stripCodexMemoryCitation } from '../server/codexMemoryCitation.js';

// The block Codex 0.166 appends when a memory informed the reply (its memory prompt), as seen on a phone, Nov 5 2026.
const CITATION = [
  '<oai-mem-citation>',
  '<citation_entries>',
  'MEMORY.md:208-208|note=[Selected private catalog sync and verification]',
  '</citation_entries>',
  '<rollout_ids>',
  '01a19f80-dcc4-7ed2-8763-985a35581a4b',
  '</rollout_ids>',
  '</oai-mem-citation>',
].join('\n');

describe('stripCodexMemoryCitation', () => {
  it('removes the block that ends a reply, and the blank lines before it', () => {
    expect(stripCodexMemoryCitation(`Reply **proceed** to create it.\n\n${CITATION}\n`)).toBe('Reply **proceed** to create it.');
  });

  it('removes it when Codex runs it on from the last sentence', () => {
    expect(stripCodexMemoryCitation(`Done. ${CITATION.replace(/\n/g, ' ')}`)).toBe('Done.');
  });

  it('removes an unclosed block cut off at the end (a capped reply)', () => {
    expect(stripCodexMemoryCitation('Done.\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|n')).toBe('Done.');
  });

  it('keeps a mention in the middle of a reply', () => {
    const text = 'Codex appends `<oai-mem-citation>` blocks.\n<oai-mem-citation></oai-mem-citation>\nThat is all.';
    expect(stripCodexMemoryCitation(text)).toBe(text);
  });

  it('keeps a block inside a code fence at the end', () => {
    const text = `Here is one:\n\`\`\`\n${CITATION}\n\`\`\``;
    expect(stripCodexMemoryCitation(text)).toBe(text);
  });

  it('leaves a reply with no block untouched', () => {
    expect(stripCodexMemoryCitation('  Done.  ')).toBe('  Done.  ');
  });

  it('is empty for a reply that is only a citation', () => {
    expect(stripCodexMemoryCitation(CITATION)).toBe('');
  });
});
