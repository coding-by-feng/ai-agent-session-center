// test/constants.test.js — Tests for server/constants.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_TYPES, SESSION_STATUS, ANIMATION_STATE, EMOTE,
  WS_TYPES, SESSION_SOURCE, KNOWN_EVENTS, ALL_CLAUDE_HOOK_EVENTS,
  DENSITY_EVENTS,
} from '../server/constants.js';

describe('EVENT_TYPES', () => {
  it('all values are strings', () => {
    for (const [key, value] of Object.entries(EVENT_TYPES)) {
      assert.equal(typeof value, 'string', `EVENT_TYPES.${key} should be a string`);
    }
  });

  it('contains expected Claude event types', () => {
    assert.equal(EVENT_TYPES.SESSION_START, 'SessionStart');
    assert.equal(EVENT_TYPES.SESSION_END, 'SessionEnd');
    assert.equal(EVENT_TYPES.USER_PROMPT_SUBMIT, 'UserPromptSubmit');
    assert.equal(EVENT_TYPES.PRE_TOOL_USE, 'PreToolUse');
    assert.equal(EVENT_TYPES.POST_TOOL_USE, 'PostToolUse');
    assert.equal(EVENT_TYPES.STOP, 'Stop');
  });

  it('contains Gemini event types', () => {
    assert.equal(EVENT_TYPES.BEFORE_AGENT, 'BeforeAgent');
    assert.equal(EVENT_TYPES.BEFORE_TOOL, 'BeforeTool');
    assert.equal(EVENT_TYPES.AFTER_TOOL, 'AfterTool');
    assert.equal(EVENT_TYPES.AFTER_AGENT, 'AfterAgent');
  });

  it('contains Codex event types', () => {
    assert.equal(EVENT_TYPES.AGENT_TURN_COMPLETE, 'agent-turn-complete');
  });

  it('has no duplicate values', () => {
    const values = Object.values(EVENT_TYPES);
    const unique = new Set(values);
    assert.equal(values.length, unique.size, 'EVENT_TYPES should have no duplicate values');
  });
});

describe('SESSION_STATUS', () => {
  it('all values are strings', () => {
    for (const [key, value] of Object.entries(SESSION_STATUS)) {
      assert.equal(typeof value, 'string', `SESSION_STATUS.${key} should be a string`);
    }
  });

  it('contains expected statuses', () => {
    assert.equal(SESSION_STATUS.IDLE, 'idle');
    assert.equal(SESSION_STATUS.PROMPTING, 'prompting');
    assert.equal(SESSION_STATUS.WORKING, 'working');
    assert.equal(SESSION_STATUS.APPROVAL, 'approval');
    assert.equal(SESSION_STATUS.WAITING, 'waiting');
    assert.equal(SESSION_STATUS.ENDED, 'ended');
  });

  it('has no duplicate values', () => {
    const values = Object.values(SESSION_STATUS);
    const unique = new Set(values);
    assert.equal(values.length, unique.size, 'SESSION_STATUS should have no duplicate values');
  });
});

describe('ANIMATION_STATE', () => {
  it('all values are strings', () => {
    for (const [key, value] of Object.entries(ANIMATION_STATE)) {
      assert.equal(typeof value, 'string', `ANIMATION_STATE.${key} should be a string`);
    }
  });

  it('has no duplicate values', () => {
    const values = Object.values(ANIMATION_STATE);
    const unique = new Set(values);
    assert.equal(values.length, unique.size);
  });
});

describe('EMOTE', () => {
  it('all values are strings', () => {
    for (const [key, value] of Object.entries(EMOTE)) {
      assert.equal(typeof value, 'string', `EMOTE.${key} should be a string`);
    }
  });

  it('has no duplicate values', () => {
    const values = Object.values(EMOTE);
    const unique = new Set(values);
    assert.equal(values.length, unique.size);
  });
});

describe('WS_TYPES', () => {
  it('all values are strings', () => {
    for (const [key, value] of Object.entries(WS_TYPES)) {
      assert.equal(typeof value, 'string', `WS_TYPES.${key} should be a string`);
    }
  });

  it('has no duplicate values', () => {
    const values = Object.values(WS_TYPES);
    const unique = new Set(values);
    assert.equal(values.length, unique.size);
  });
});

describe('SESSION_SOURCE', () => {
  it('all values are strings', () => {
    for (const [key, value] of Object.entries(SESSION_SOURCE)) {
      assert.equal(typeof value, 'string', `SESSION_SOURCE.${key} should be a string`);
    }
  });

  it('has no duplicate values', () => {
    const values = Object.values(SESSION_SOURCE);
    const unique = new Set(values);
    assert.equal(values.length, unique.size);
  });
});

describe('KNOWN_EVENTS', () => {
  it('is a Set', () => {
    assert.ok(KNOWN_EVENTS instanceof Set);
  });

  it('contains all ALL_CLAUDE_HOOK_EVENTS values', () => {
    for (const event of ALL_CLAUDE_HOOK_EVENTS) {
      assert.ok(KNOWN_EVENTS.has(event), `KNOWN_EVENTS should contain ${event}`);
    }
  });

  it('contains all EVENT_TYPES values', () => {
    for (const [key, value] of Object.entries(EVENT_TYPES)) {
      assert.ok(KNOWN_EVENTS.has(value), `KNOWN_EVENTS should contain EVENT_TYPES.${key} (${value})`);
    }
  });

  it('contains Gemini events', () => {
    assert.ok(KNOWN_EVENTS.has('BeforeAgent'));
    assert.ok(KNOWN_EVENTS.has('BeforeTool'));
    assert.ok(KNOWN_EVENTS.has('AfterTool'));
    assert.ok(KNOWN_EVENTS.has('AfterAgent'));
  });

  it('contains Codex events', () => {
    assert.ok(KNOWN_EVENTS.has('agent-turn-complete'));
  });
});

describe('DENSITY_EVENTS', () => {
  it('has high, medium, low presets', () => {
    assert.ok(Array.isArray(DENSITY_EVENTS.high));
    assert.ok(Array.isArray(DENSITY_EVENTS.medium));
    assert.ok(Array.isArray(DENSITY_EVENTS.low));
  });

  it('high contains more events than medium', () => {
    assert.ok(DENSITY_EVENTS.high.length >= DENSITY_EVENTS.medium.length);
  });

  it('medium contains more events than low', () => {
    assert.ok(DENSITY_EVENTS.medium.length >= DENSITY_EVENTS.low.length);
  });

  it('low contains essential events', () => {
    assert.ok(DENSITY_EVENTS.low.includes(EVENT_TYPES.SESSION_START));
    assert.ok(DENSITY_EVENTS.low.includes(EVENT_TYPES.SESSION_END));
    assert.ok(DENSITY_EVENTS.low.includes(EVENT_TYPES.STOP));
  });
});
