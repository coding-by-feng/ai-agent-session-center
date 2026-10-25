// test/mcp/tools.queueTexts.test.ts — P4-32 M2: this build is phase 4, so no tool description promises "(P4)" or "until a
// central opens its own workers" as something to come. The words say what P4 does: a central's own worker is exempt
// (Ruling P4-12), every other session keeps the lock.
import { describe, expect, it } from 'vitest';
import { ON_LOCK } from '../../server/mcp/tools/queueWriteKit.js';
import { allTools, MCP_MAX_PHASE } from '../../server/mcp/registry.js';

const FUTURE = /\(P4\)|until a central opens its own workers|until it opens its own workers|comes in a later version/i;

describe('queue tool texts in a phase-4 build', () => {
  it('is a phase-4 build', () => {
    expect(MCP_MAX_PHASE).toBeGreaterThanOrEqual(4);
  });

  it.each(allTools().filter((t) => t.toolset === 'queue').map((t) => [t.name, t.description] as const))(
    '%s does not promise P4 as future',
    (_name, description) => {
      expect(description).not.toMatch(FUTURE);
    },
  );

  it('tells a central what its own worker allows, on every tool that locks an unattended run', () => {
    const locked = [
      'queue_move_item',
      'queue_set_item_enabled',
      'queue_fire_now',
      'queue_set_paused',
      'queue_set_auto_send',
      'queue_set_automation',
      'queue_resume_after_cancel',
    ];
    for (const name of locked) {
      const tool = allTools().find((t) => t.name === name)!;
      expect(tool.description, name).toMatch(/opened itself|its own workers? (are|is) exempt|a worker it opened/i);
    }
  });

  it('words the on-prompt lock for the central’s own worker too', () => {
    expect(ON_LOCK).not.toMatch(FUTURE);
    expect(ON_LOCK).toMatch(/opened itself/);
  });
});
