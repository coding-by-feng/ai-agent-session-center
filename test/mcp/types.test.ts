// test/mcp/types.test.ts — the toolset constants and ToolError every other server/mcp module imports.
import { describe, expect, it } from 'vitest';
import { ALL_TOOLSETS, CORE_TOOLSETS, ToolError, type Toolset } from '../../server/mcp/types.js';

describe('toolset constants', () => {
  it('ALL_TOOLSETS lists the fifteen toolsets once each', () => {
    expect([...ALL_TOOLSETS]).toEqual([
      'sessions',
      'conversation',
      'prompts',
      'tasks',
      'requests',
      'queue',
      'rooms',
      'resources',
      'skillNotes',
      'snippets',
      'history',
      'notes',
      'agenda',
      'cloud',
      'system',
    ]);
    expect(new Set(ALL_TOOLSETS).size).toBe(ALL_TOOLSETS.length);
  });

  it('CORE_TOOLSETS is the seven a Codex central gets, all of them real toolsets', () => {
    expect([...CORE_TOOLSETS]).toEqual([
      'sessions',
      'conversation',
      'prompts',
      'tasks',
      'requests',
      'queue',
      'system',
    ]);
    for (const toolset of CORE_TOOLSETS) expect(ALL_TOOLSETS).toContain(toolset);
  });

  it('cannot be changed by a caller', () => {
    expect(() => (ALL_TOOLSETS as Toolset[]).push('sessions')).toThrow(TypeError);
    expect(() => (CORE_TOOLSETS as Toolset[]).pop()).toThrow(TypeError);
  });
});

describe('ToolError', () => {
  it('is an Error that carries a code, a message and an optional hint', () => {
    const error = new ToolError(
      'NOT_IN_SCOPE',
      'Session s1 is outside this central',
      'List sessions first',
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ToolError);
    expect(error.name).toBe('ToolError');
    expect(error.code).toBe('NOT_IN_SCOPE');
    expect(error.message).toBe('Session s1 is outside this central');
    expect(error.hint).toBe('List sessions first');
  });

  it('has no hint unless one is given, and a message that defaults to the code', () => {
    const error = new ToolError('INVALID');

    expect(error.code).toBe('INVALID');
    expect(error.message).toBe('INVALID');
    expect(error.hint).toBeUndefined();
  });
});
