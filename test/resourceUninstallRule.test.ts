/**
 * The uninstall eligibility rule — one function shared by the server (which
 * enforces it) and the RESOURCES tab (which decides whether to offer it).
 */
import { describe, it, expect } from 'vitest';
import { RESOURCE_TYPES, UNINSTALLABLE_TYPES, isUninstallableType, uninstallBlocker } from '../src/types/resources.js';
import type { ResourceSummary } from '../src/types/resources.js';

type Rule = Pick<ResourceSummary, 'type' | 'origin' | 'linkTarget' | 'pluginName'>;
const userSkill: Rule = { type: 'skill', origin: 'user' };

describe('uninstall eligibility', () => {
  it('covers exactly the file-backed types', () => {
    expect([...UNINSTALLABLE_TYPES].sort()).toEqual(['agent', 'command', 'memory', 'rule', 'skill']);
    for (const type of UNINSTALLABLE_TYPES) expect(isUninstallableType(type)).toBe(true);
  });

  it('never offers config entries, instructions or plugins', () => {
    for (const type of RESOURCE_TYPES.filter((t) => !isUninstallableType(t))) {
      expect(isUninstallableType(type)).toBe(false);
      expect(uninstallBlocker({ ...userSkill, type })).not.toBeNull();
    }
  });

  it('allows a user-owned file-backed resource', () => {
    for (const type of UNINSTALLABLE_TYPES) expect(uninstallBlocker({ ...userSkill, type })).toBeNull();
  });

  it('refuses what someone else owns, saying where to remove it instead', () => {
    expect(uninstallBlocker({ ...userSkill, origin: 'plugin', pluginName: 'superpowers' })).toMatch(/superpowers/);
    expect(uninstallBlocker({ ...userSkill, origin: 'system' })).toMatch(/CLI/);
    expect(uninstallBlocker({ ...userSkill, origin: 'synced' })).toMatch(/claude\.ai/);
    expect(uninstallBlocker({ ...userSkill, origin: 'linked', linkTarget: '~/code/agent-skills/x' })).toMatch(/~\/code\/agent-skills\/x/);
  });

  it('refuses a symlink even when it resolves inside its own root', () => {
    expect(uninstallBlocker({ ...userSkill, linkTarget: '~/.claude/skills/real' })).toMatch(/link/i);
  });
});
