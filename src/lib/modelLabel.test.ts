import { describe, it, expect } from 'vitest';
import { formatModelLabel, modelLabelKey, modelFlagFromLabel } from './modelLabel';

describe('formatModelLabel', () => {
  it('turns a current-format model ID into "Family major.minor"', () => {
    expect(formatModelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(formatModelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(formatModelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(formatModelLabel('claude-fable-5')).toBe('Fable 5');
    expect(formatModelLabel('claude-haiku-4-5')).toBe('Haiku 4.5');
  });

  it('reads the older "claude-<version>-<family>" IDs too', () => {
    expect(formatModelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(formatModelLabel('claude-3-opus-20240229')).toBe('Opus 3');
  });

  it('capitalises a tier alias and keeps a display name as Claude Code printed it', () => {
    expect(formatModelLabel('opus')).toBe('Opus');
    expect(formatModelLabel('Opus 5.5')).toBe('Opus 5.5');
  });

  it('marks the 1M-context variant instead of dropping it', () => {
    expect(formatModelLabel('claude-sonnet-4-5[1m]')).toBe('Sonnet 4.5 1M');
    expect(formatModelLabel('sonnet[1m]')).toBe('Sonnet 1M');
  });

  it('leaves an unrecognised model alone and an empty one empty', () => {
    expect(formatModelLabel('gpt-5-codex')).toBe('gpt-5-codex');
    expect(formatModelLabel('  ')).toBe('');
  });
});

describe('modelLabelKey', () => {
  it('equates an ID with the display name Claude Code prints for it', () => {
    expect(modelLabelKey('claude-opus-5-5')).toBe(modelLabelKey('Opus 5.5'));
    expect(modelLabelKey('claude-opus-5-5')).not.toBe(modelLabelKey('claude-haiku-4-5'));
  });
});

describe('modelFlagFromLabel', () => {
  it('keeps an ID or a tier alias as it is: both are valid --model values', () => {
    expect(modelFlagFromLabel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(modelFlagFromLabel('opus')).toBe('opus');
    expect(modelFlagFromLabel('gpt-6-astra')).toBe('gpt-6-astra');
  });

  it('turns the display name /model prints back into the ID it stands for', () => {
    expect(modelFlagFromLabel('Opus 5.5')).toBe('claude-opus-5-5');
    expect(modelFlagFromLabel(' Haiku 5.5 ')).toBe('claude-haiku-5-5');
  });

  it('REVIEW: does not guess an ID for a name without a minor version, or an old family', () => {
    // `Sonnet 4` is claude-sonnet-4-0 / -20250514, `Sonnet 3.7` is claude-3-7-sonnet:
    // rebuilding them from the name gives IDs that do not exist.
    expect(modelFlagFromLabel('Sonnet 4')).toBeUndefined();
    expect(modelFlagFromLabel('Opus 4')).toBeUndefined();
    expect(modelFlagFromLabel('Sonnet 3.7')).toBeUndefined();
  });

  it('gives nothing for a name it cannot turn into a valid flag', () => {
    expect(modelFlagFromLabel('Sonnet 1M')).toBeUndefined();
    expect(modelFlagFromLabel('Opus 5.5 (1M context)')).toBeUndefined();
    expect(modelFlagFromLabel('sonnet[1m]')).toBeUndefined();
    expect(modelFlagFromLabel('Default (recommended)')).toBeUndefined();
    expect(modelFlagFromLabel('')).toBeUndefined();
    expect(modelFlagFromLabel(undefined)).toBeUndefined();
  });
});
