import { describe, it, expect } from 'vitest';
import { EFFORT_LEVELS } from '@/lib/remoteControlName';
import {
  EFFORT_STEP_LEVELS,
  effortLevelSavesDefault,
  effortStepText,
  isEffortCommand,
} from './queueEffort';

describe('effortStepText', () => {
  it('is the exact slash command Claude Code takes for each level', () => {
    for (const level of EFFORT_LEVELS) {
      expect(effortStepText(level)).toBe(`/effort ${level}`);
    }
  });

  it('never trails whitespace — chain steps are trimmed before save, but the text is compared as-is', () => {
    for (const level of EFFORT_LEVELS) {
      const text = effortStepText(level);
      expect(text).toBe(text.trim());
    }
  });
});

describe('EFFORT_STEP_LEVELS', () => {
  it('offers every effort level, in the order the session modals list them', () => {
    expect([...EFFORT_STEP_LEVELS]).toEqual([...EFFORT_LEVELS]);
  });

  it('includes ultracode: the --effort flag rejects it, the /effort command does not', () => {
    expect(EFFORT_STEP_LEVELS).toContain('ultracode');
  });
});

describe('isEffortCommand', () => {
  it('recognises the text the picker writes, for every level', () => {
    for (const level of EFFORT_LEVELS) {
      expect(isEffortCommand(effortStepText(level))).toBe(true);
    }
  });

  it('tolerates the whitespace a hand-typed step picks up', () => {
    expect(isEffortCommand('  /effort   max  ')).toBe(true);
    expect(isEffortCommand('/effort\tlow\n')).toBe(true);
  });

  it('rejects a bare /effort — that opens a picker, which is not a silent one-shot', () => {
    expect(isEffortCommand('/effort')).toBe(false);
    expect(isEffortCommand('/effort ')).toBe(false);
  });

  it('rejects an unknown level, so a typo never gets the short release', () => {
    expect(isEffortCommand('/effort turbo')).toBe(false);
    expect(isEffortCommand('/effort Max')).toBe(false);
  });

  it('rejects anything that is not exactly the command', () => {
    expect(isEffortCommand('/effort max please')).toBe(false);
    expect(isEffortCommand('/effort max\nthen do the work')).toBe(false);
    expect(isEffortCommand('/effortless')).toBe(false);
    expect(isEffortCommand('effort max')).toBe(false);
    expect(isEffortCommand('run /effort max')).toBe(false);
    expect(isEffortCommand('')).toBe(false);
  });
});

describe('effortLevelSavesDefault', () => {
  // Observed on Claude Code 2.1.296: `/effort high` answers "saved as your default
  // for new sessions" and writes modelSettings.<model>.effortLevel into
  // ~/.claude/settings.json; `/effort max` and `/effort ultracode` answer
  // "this session only".
  it('is true for the levels the CLI saves as the new-session default', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh'] as const) {
      expect(effortLevelSavesDefault(level)).toBe(true);
    }
  });

  it('is false for the session-only levels', () => {
    expect(effortLevelSavesDefault('max')).toBe(false);
    expect(effortLevelSavesDefault('ultracode')).toBe(false);
  });
});
