// test/constants.test.ts — Tests for server/constants.ts
import { describe, it, expect } from 'vitest';
import {
  EVENT_TYPES, SESSION_STATUS, ANIMATION_STATE, EMOTE,
  WS_TYPES, SESSION_SOURCE, KNOWN_EVENTS, ALL_CLAUDE_HOOK_EVENTS,
  DENSITY_EVENTS,
} from '../server/constants.js';

describe('EVENT_TYPES', () => {
  it('all values are strings', () => {
    for (const [key, value] of Object.entries(EVENT_TYPES)) {
      expect(typeof value).toBe('string');
    }
  });

  it('contains expected Claude event types', () => {
    expect(EVENT_TYPES.SESSION_START).toBe('SessionStart');
    expect(EVENT_TYPES.SESSION_END).toBe('SessionEnd');
    expect(EVENT_TYPES.USER_PROMPT_SUBMIT).toBe('UserPromptSubmit');
    expect(EVENT_TYPES.PRE_TOOL_USE).toBe('PreToolUse');
    expect(EVENT_TYPES.POST_TOOL_USE).toBe('PostToolUse');
    expect(EVENT_TYPES.STOP).toBe('Stop');
  });

  it('contains Gemini event types', () => {
    expect(EVENT_TYPES.BEFORE_AGENT).toBe('BeforeAgent');
    expect(EVENT_TYPES.BEFORE_TOOL).toBe('BeforeTool');
    expect(EVENT_TYPES.AFTER_TOOL).toBe('AfterTool');
    expect(EVENT_TYPES.AFTER_AGENT).toBe('AfterAgent');
  });

  it('contains Codex event types', () => {
    expect(EVENT_TYPES.AGENT_TURN_COMPLETE).toBe('agent-turn-complete');
  });

  it('has no duplicate values', () => {
    const values = Object.values(EVENT_TYPES);
    const unique = new Set(values);
    expect(values.length).toBe(unique.size);
  });
});

describe('SESSION_STATUS', () => {
  it('all values are strings', () => {
    for (const [key, value] of Object.entries(SESSION_STATUS)) {
      expect(typeof value).toBe('string');
    }
  });

  it('contains expected statuses', () => {
    expect(SESSION_STATUS.IDLE).toBe('idle');
    expect(SESSION_STATUS.PROMPTING).toBe('prompting');
    expect(SESSION_STATUS.WORKING).toBe('working');
    expect(SESSION_STATUS.APPROVAL).toBe('approval');
    expect(SESSION_STATUS.WAITING).toBe('waiting');
    expect(SESSION_STATUS.ENDED).toBe('ended');
  });

  it('has no duplicate values', () => {
    const values = Object.values(SESSION_STATUS);
    const unique = new Set(values);
    expect(values.length).toBe(unique.size);
  });
});

describe('ANIMATION_STATE', () => {
  it('all values are strings', () => {
    for (const [key, value] of Object.entries(ANIMATION_STATE)) {
      expect(typeof value).toBe('string');
    }
  });

  it('has no duplicate values', () => {
    const values = Object.values(ANIMATION_STATE);
    const unique = new Set(values);
    expect(values.length).toBe(unique.size);
  });
});

describe('EMOTE', () => {
  it('all values are strings', () => {
    for (const [key, value] of Object.entries(EMOTE)) {
      expect(typeof value).toBe('string');
    }
  });

  it('has no duplicate values', () => {
    const values = Object.values(EMOTE);
    const unique = new Set(values);
    expect(values.length).toBe(unique.size);
  });
});

describe('WS_TYPES', () => {
  it('all values are strings', () => {
    for (const [key, value] of Object.entries(WS_TYPES)) {
      expect(typeof value).toBe('string');
    }
  });

  it('has no duplicate values', () => {
    const values = Object.values(WS_TYPES);
    const unique = new Set(values);
    expect(values.length).toBe(unique.size);
  });
});

describe('SESSION_SOURCE', () => {
  it('all values are strings', () => {
    for (const [key, value] of Object.entries(SESSION_SOURCE)) {
      expect(typeof value).toBe('string');
    }
  });

  it('has no duplicate values', () => {
    const values = Object.values(SESSION_SOURCE);
    const unique = new Set(values);
    expect(values.length).toBe(unique.size);
  });
});

describe('KNOWN_EVENTS', () => {
  it('is a Set', () => {
    expect(KNOWN_EVENTS).toBeInstanceOf(Set);
  });

  it('contains all ALL_CLAUDE_HOOK_EVENTS values', () => {
    for (const event of ALL_CLAUDE_HOOK_EVENTS) {
      expect(KNOWN_EVENTS.has(event)).toBe(true);
    }
  });

  it('contains all EVENT_TYPES values', () => {
    for (const [key, value] of Object.entries(EVENT_TYPES)) {
      expect(KNOWN_EVENTS.has(value)).toBe(true);
    }
  });

  it('contains Gemini events', () => {
    expect(KNOWN_EVENTS.has('BeforeAgent')).toBe(true);
    expect(KNOWN_EVENTS.has('BeforeTool')).toBe(true);
    expect(KNOWN_EVENTS.has('AfterTool')).toBe(true);
    expect(KNOWN_EVENTS.has('AfterAgent')).toBe(true);
  });

  it('contains Codex events', () => {
    expect(KNOWN_EVENTS.has('agent-turn-complete')).toBe(true);
  });
});

describe('DENSITY_EVENTS', () => {
  it('has high, medium, low presets', () => {
    expect(Array.isArray(DENSITY_EVENTS.high)).toBe(true);
    expect(Array.isArray(DENSITY_EVENTS.medium)).toBe(true);
    expect(Array.isArray(DENSITY_EVENTS.low)).toBe(true);
  });

  it('high contains more events than medium', () => {
    expect(DENSITY_EVENTS.high.length).toBeGreaterThanOrEqual(DENSITY_EVENTS.medium.length);
  });

  it('medium contains more events than low', () => {
    expect(DENSITY_EVENTS.medium.length).toBeGreaterThanOrEqual(DENSITY_EVENTS.low.length);
  });

  it('low contains essential events', () => {
    expect(DENSITY_EVENTS.low).toContain(EVENT_TYPES.SESSION_START);
    expect(DENSITY_EVENTS.low).toContain(EVENT_TYPES.SESSION_END);
    expect(DENSITY_EVENTS.low).toContain(EVENT_TYPES.STOP);
  });
});
