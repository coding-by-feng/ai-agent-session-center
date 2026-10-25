// tools/terminals.ts — the terminals a central may read, P1: which agent terminals are in scope, and what one
// printed lately. Part of the conversation toolset.
//
// Scope is by session: a terminal is listed, and its output read, only through a session in scope. An ops shell
// (a session's blank "Commands Terminal") is never offered, nor is a terminal that belongs to no session in
// scope; the terminal of an in-scope session that runs over SSH is its own session's, so it is. A terminal's
// output is whatever the session's program printed, so it comes fenced as untrusted.

import { z } from 'zod';
import type { TerminalInfo } from '../../../src/types/terminal.js';
import { stripAnsi } from '../../../src/lib/ansi.js';
import type { ToolDef } from '../registry.js';
import { shortIdOf } from '../scope.js';
import { ToolError } from '../types.js';
import { defineTool, fence, plural, refOf, resolveTarget, seg, SESSION_REF, sessionSource, unwrap } from './define.js';

/** The most characters of output handed over, from the end. */
const OUTPUT_MAX = 40_000;
const DEFAULT_LINES = 200;
const MAX_LINES = 2_000;

/** Control characters other than newline and tab; ANSI sequences are gone by the time this runs. */
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Terminal bytes as lines of plain text: a carriage return keeps only what was written last on the line (a
 * progress bar), ANSI sequences and control characters are removed, trailing spaces and trailing blank lines
 * are dropped, and a run of blank lines (a redrawn screen) becomes one.
 */
export function terminalLines(raw: string): string[] {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => stripAnsi(line.slice(line.lastIndexOf('\r') + 1)).replace(CONTROL, '').trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.filter((line, i) => line !== '' || i === 0 || lines[i - 1] !== '');
}

// ---------------------------------------------------------------------------
// terminal_list
// ---------------------------------------------------------------------------

const terminalList = defineTool({
  name: 'terminal_list',
  toolset: 'conversation',
  title: 'List terminals',
  description:
    'Lists the agent terminals of the sessions in your scope: the terminal id, the session it belongs to and ' +
    'its folder. Ops shells are never offered, nor terminals that belong to no session of yours.',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    const body = unwrap<{ terminals?: TerminalInfo[] }>(await ctx.client.get('/terminals'));
    const scoped = ctx.scopedSessions();
    const ref = refOf(ctx);
    const terminals = (Array.isArray(body.terminals) ? body.terminals : [])
      .filter((t) => t.isOps !== true)
      .flatMap((t) => {
        const owner = scoped.find((s) => s.terminalId === t.terminalId) ?? scoped.find((s) => s.sessionId === t.sessionId);
        if (owner === undefined) return [];
        return [{ terminalId: t.terminalId, sessionId: owner.sessionId, shortId: shortIdOf(owner.sessionId), workingDir: t.workingDir, createdAt: t.createdAt }];
      });
    if (terminals.length === 0) {
      return { data: { count: 0, terminals }, summary: 'No terminals in your scope.' };
    }
    const rows = terminals.map((t) => `${t.terminalId} · session ${ref(t.sessionId)} · ${t.workingDir}`);
    return {
      data: { count: terminals.length, terminals },
      summary: `${plural(terminals.length, 'terminal')} in your scope:\n${fence('aasc', 'terminals', rows.join('\n'))}`,
    };
  },
});

// ---------------------------------------------------------------------------
// terminal_output
// ---------------------------------------------------------------------------

const terminalOutput = defineTool({
  name: 'terminal_output',
  toolset: 'conversation',
  title: 'A terminal’s output',
  description:
    'Reads the last lines a session’s terminal printed (200 by default, up to 2000), as plain text: colours and ' +
    'cursor codes removed, a progress bar kept at its last state, cut at 40 000 characters. It is whatever the ' +
    'program printed, fenced as untrusted data. Prefer chat_read for what the agent said; this shows the screen.',
  risk: 'read',
  phase: 1,
  input: {
    id: SESSION_REF,
    lines: z.number().int().min(1).max(MAX_LINES).optional().describe(`How many of the last lines, 1 to ${MAX_LINES} (default ${DEFAULT_LINES}).`),
  },
  async run(args, ctx) {
    const s = resolveTarget(ctx, args.id);
    const ref = refOf(ctx)(s.sessionId);
    if (!s.terminalId) {
      throw new ToolError(
        'UNAVAILABLE',
        'That session has no terminal AASC owns (it runs outside the dashboard).',
        'Use chat_read for what it said.',
      );
    }
    const body = unwrap<{ output?: unknown }>(await ctx.client.get(`/terminals/${seg(s.terminalId)}/output`));
    const raw = typeof body.output === 'string' ? Buffer.from(body.output, 'base64').toString('utf8') : '';
    const all = terminalLines(raw);
    const kept = all.slice(-(args.lines ?? DEFAULT_LINES));
    const text = kept.join('\n');
    const truncated = text.length > OUTPUT_MAX;
    const shownText = truncated ? text.slice(-OUTPUT_MAX) : text;
    const shown = shownText === '' ? [] : shownText.split('\n');
    const output = fence(sessionSource(s.sessionId), 'terminal', shownText);
    const data = {
      id: s.sessionId,
      shortId: shortIdOf(s.sessionId),
      terminalId: s.terminalId,
      lines: shown.length,
      totalLines: all.length,
      truncated,
      output,
    };
    if (shown.length === 0) return { data, summary: `Terminal of ${ref} has no output yet.` };
    const note = truncated ? ` Cut at ${OUTPUT_MAX} characters, keeping the end.` : '';
    return {
      data,
      summary: `Terminal of ${ref}: the last ${shown.length} of ${all.length} lines.${note}\n${output}`,
    };
  },
});

export const terminalTools: readonly ToolDef[] = [terminalList, terminalOutput];
