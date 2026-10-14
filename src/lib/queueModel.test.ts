import { describe, it, expect } from 'vitest';
import {
  MODEL_STEP_OPTIONS,
  isModelAlias,
  isModelCommand,
  modelStepText,
} from './queueModel';
import { MODEL_OPTIONS } from './remoteControlName';

describe('queueModel', () => {
  it('offers the same models the session creation modals do, aliases first', () => {
    expect(MODEL_STEP_OPTIONS).toEqual(MODEL_OPTIONS);
    expect(MODEL_STEP_OPTIONS.slice(0, 4)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });

  it('writes the step as the /model slash command', () => {
    expect(modelStepText('opus')).toBe('/model opus');
    expect(modelStepText('claude-opus-4-8')).toBe('/model claude-opus-4-8');
  });

  it('tells a tier alias (latest) from a pinned model ID', () => {
    expect(isModelAlias('sonnet')).toBe(true);
    expect(isModelAlias('claude-sonnet-4-6')).toBe(false);
  });

  it('recognises exactly one /model <name> command, including IDs not in the list', () => {
    expect(isModelCommand('/model opus')).toBe(true);
    expect(isModelCommand('  /model   haiku  ')).toBe(true);
    expect(isModelCommand('/model claude-opus-5-5')).toBe(true);
    expect(isModelCommand('/model claude-sonnet-4-5[1m]')).toBe(true);
  });

  it('REGRESSION GUARD: a bare /model opens an interactive picker, so it is never a silent command', () => {
    expect(isModelCommand('/model')).toBe(false);
    expect(isModelCommand('/model   ')).toBe(false);
  });

  it('anything more than one name is an ordinary prompt', () => {
    expect(isModelCommand('/model opus please')).toBe(false);
    expect(isModelCommand('/model opus\nthen do the thing')).toBe(false);
    expect(isModelCommand('use /model opus')).toBe(false);
    expect(isModelCommand('/models opus')).toBe(false);
    expect(isModelCommand('/effort high')).toBe(false);
  });
});
