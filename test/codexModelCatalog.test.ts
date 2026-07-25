import { describe, expect, it } from 'vitest';
import { normalizeCodexModelList } from '../server/codexModelCatalog.js';

describe('normalizeCodexModelList', () => {
  it('preserves official order and maps picker fields', () => {
    expect(normalizeCodexModelList({
      data: [
        {
          id: 'gpt-newest',
          displayName: 'GPT Newest',
          description: 'Current default.',
          hidden: false,
          isDefault: true,
        },
        {
          id: 'gpt-fast',
          displayName: 'GPT Fast',
          description: 'Fast model.',
          hidden: false,
          isDefault: false,
        },
      ],
    })).toEqual([
      {
        id: 'gpt-newest',
        displayName: 'GPT Newest',
        description: 'Current default.',
        isDefault: true,
      },
      {
        id: 'gpt-fast',
        displayName: 'GPT Fast',
        description: 'Fast model.',
        isDefault: false,
      },
    ]);
  });

  it('excludes hidden, duplicate, and shell-unsafe model ids', () => {
    expect(normalizeCodexModelList({
      data: [
        { id: 'visible', displayName: '', hidden: false },
        { id: 'visible', displayName: 'Duplicate', hidden: false },
        { id: 'hidden', displayName: 'Hidden', hidden: true },
        { id: 'unsafe model;rm', displayName: 'Unsafe', hidden: false },
        null,
      ],
    })).toEqual([
      {
        id: 'visible',
        displayName: 'visible',
        description: '',
        isDefault: false,
      },
    ]);
  });

  it('returns an empty list for malformed responses', () => {
    expect(normalizeCodexModelList(null)).toEqual([]);
    expect(normalizeCodexModelList({ data: 'not-an-array' })).toEqual([]);
  });
});
