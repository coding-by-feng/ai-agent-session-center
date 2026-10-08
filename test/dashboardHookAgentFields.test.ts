// test/dashboardHookAgentFields.test.ts — hooks/dashboard-hook.sh's jq enrichment
//
// The hook overwrites `agent_id` / `agent_type` with the agent-team env vars (null
// outside a team): team linking reads them that way and must keep doing so. But
// Claude Code puts its OWN `agent_id` / `agent_type` on every event fired inside a
// subagent, and the AGENTS tab needs those, so the hook preserves them as
// `claude_agent_id` / `claude_agent_type`.
//
// Running the whole script would append to the live dashboard queue
// (/tmp/claude-session-center/queue.jsonl is hard-coded), so this runs the
// script's own jq program, extracted from the file, against sample payloads.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const SCRIPT = fileURLToPath(new URL('../hooks/dashboard-hook.sh', import.meta.url));
const hasJq = spawnSync('jq', ['--version']).status === 0;

/** The `jq -c` invocation's --arg names and its single-quoted program. */
function extractJq(): { argNames: string[]; program: string } {
  const src = readFileSync(SCRIPT, 'utf8');
  const start = src.indexOf('JQ_OUT=$(echo "$INPUT" | jq -c');
  if (start < 0) throw new Error('jq invocation not found in dashboard-hook.sh');
  const progOpen = src.indexOf("'", start);
  const progClose = src.indexOf("' 2>/dev/null)", progOpen + 1);
  const argNames = [...src.slice(start, progOpen).matchAll(/--arg (\w+) /g)].map((m) => m[1]);
  return { argNames, program: src.slice(progOpen + 1, progClose) };
}

function enrich(payload: Record<string, unknown>, env: Record<string, string> = {}): Record<string, unknown> {
  const { argNames, program } = extractJq();
  const args = argNames.flatMap((name) => {
    const value = name === 'pid' || name === 'sent_at' ? '1' : env[name] ?? '';
    return ['--arg', name, value];
  });
  const res = spawnSync('jq', ['-c', ...args, program], { input: JSON.stringify(payload), encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`jq failed: ${res.stderr}`);
  return JSON.parse(res.stdout.split('\n')[0]) as Record<string, unknown>;
}

describe.skipIf(!hasJq)('dashboard-hook.sh agent fields', () => {
  it('preserves Claude\'s own agent_id/agent_type from a tool call inside a subagent', () => {
    const out = enrich({
      hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash',
      agent_id: 'aef7301b0d329d4ad', agent_type: 'Explore',
    });
    expect(out.claude_agent_id).toBe('aef7301b0d329d4ad');
    expect(out.claude_agent_type).toBe('Explore');
  });

  it('still overwrites agent_id/agent_type with the team env (null outside a team), as team linking expects', () => {
    const out = enrich({ hook_event_name: 'SubagentStart', session_id: 's', agent_id: 'a1', agent_type: 'Explore' });
    expect(out.agent_id).toBeNull();
    expect(out.agent_type).toBeNull();
  });

  it('keeps both identities apart inside an agent team', () => {
    const out = enrich(
      { hook_event_name: 'PreToolUse', session_id: 's', agent_id: 'sub-1', agent_type: 'Explore' },
      { cc_agent_id: 'teammate-7', cc_agent_type: 'researcher' },
    );
    expect(out).toMatchObject({
      agent_id: 'teammate-7', agent_type: 'researcher',
      claude_agent_id: 'sub-1', claude_agent_type: 'Explore',
    });
  });

  it('writes null preserved fields on the leader\'s own events', () => {
    const out = enrich({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Read' });
    expect(out).toHaveProperty('claude_agent_id', null);
    expect(out).toHaveProperty('claude_agent_type', null);
  });
});
