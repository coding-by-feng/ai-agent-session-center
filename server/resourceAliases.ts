/**
 * resourceAliases — real abbreviation commands for Claude Code and Codex.
 *
 * An abbreviation set in the Library (`rar` → `retouch-ascii-review`) lives in
 * the browser, where only AASC's prompt box understands it. This module also
 * writes the small file each CLI reads, so typing `/rar` (Claude) or `$rar`
 * (Codex) works inside the CLI itself. The shapes follow the shortcut files
 * already in use (`Shortcut for /<target> — …`), which the Library and the
 * prompt autocomplete already recognise.
 *
 * | Agent  | Target  | File                                  | Typed        |
 * |--------|---------|---------------------------------------|--------------|
 * | claude | any     | ~/.claude/commands/<abbr>.md          | /<abbr>      |
 * | codex  | skill   | ~/.codex/skills/<abbr>/SKILL.md       | $<abbr>      |
 * | codex  | command | ~/.codex/prompts/<abbr>.md            | /prompts:<abbr> |
 * | shared | any     | the Claude and the Codex rows above   |              |
 *
 * These are writes into folders the user also edits by hand, so the rules are
 * about refusing: AASC only ever creates, replaces or deletes a file carrying
 * its marker; a hand-written file of the same name, or a symlink, is left
 * alone and reported; every name is validated before it becomes a path; and a
 * request either writes all of its files or none. An abbreviation that is the
 * name of a real skill or command (for that agent) is refused: it would
 * shadow it.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

/** Written into every file AASC creates; its presence is the ownership test. */
export const ALIAS_MARKER = 'aasc-alias:v1';

/** Same rule as the browser's (src/lib/skillNotes.ts ABBR_RE): the server never trusts it. */
export const ABBR_RE = /^[a-z0-9][a-z0-9_-]{1,11}$/;
/** A skill or command name, namespaced names (`superpowers:brainstorming`) included. No shell or path characters. */
export const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export type AliasAgent = 'claude' | 'codex' | 'shared';
export type AliasKind = 'skill' | 'command';
export type AliasAction = 'created' | 'updated' | 'unchanged' | 'removed' | 'kept' | 'absent';

export interface AliasResult {
  files: { path: string; action: AliasAction }[];
}

export class AliasError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AliasError';
  }
}

export interface AliasRequest {
  agent: AliasAgent;
  kind: AliasKind;
  target: string;
  abbr: string;
}

export interface AliasDeps {
  home?: string;
  /** `agent:name` keys of every real skill and command (the catalog's). Omitted → not checked. */
  realNames?: ReadonlySet<string>;
}

interface AliasFile {
  cli: 'claude' | 'codex';
  abs: string;
  display: string;
  /** The folder a Codex skill alias owns; removed with the file when nothing else is in it. */
  ownDir?: string;
  /** The CLI's home folder, which must already exist (we never set a CLI up for it). */
  cliHome: string;
}

function checkAbbr(abbr: string): void {
  if (!ABBR_RE.test(abbr)) throw new AliasError(400, 'Abbreviation must be 2–12 lowercase letters, digits, "-" or "_".');
}

/** The files an alias of this agent and kind occupies. `abbr` must already be validated. */
export function aliasFilesFor(agent: AliasAgent, kind: AliasKind, abbr: string, home: string = homedir()): AliasFile[] {
  const files: AliasFile[] = [];
  if (agent === 'claude' || agent === 'shared') {
    files.push({
      cli: 'claude',
      abs: join(home, '.claude', 'commands', `${abbr}.md`),
      display: `~/.claude/commands/${abbr}.md`,
      cliHome: join(home, '.claude'),
    });
  }
  if (agent === 'codex' || agent === 'shared') {
    if (kind === 'skill') {
      files.push({
        cli: 'codex',
        abs: join(home, '.codex', 'skills', abbr, 'SKILL.md'),
        display: `~/.codex/skills/${abbr}/SKILL.md`,
        ownDir: join(home, '.codex', 'skills', abbr),
        cliHome: join(home, '.codex'),
      });
    } else {
      files.push({
        cli: 'codex',
        abs: join(home, '.codex', 'prompts', `${abbr}.md`),
        display: `~/.codex/prompts/${abbr}.md`,
        cliHome: join(home, '.codex'),
      });
    }
  }
  return files;
}

function contentFor(file: AliasFile, req: AliasRequest): string {
  const { target, abbr, kind } = req;
  if (file.cli === 'codex' && kind === 'skill') {
    return [
      '---',
      `name: ${abbr}`,
      `description: "Shortcut for $${target}. Use when the user invokes $${abbr}."`,
      '---',
      '',
      `<!-- ${ALIAS_MARKER} -->`,
      '',
      `# ${abbr} — ${target}`,
      '',
      `Use the \`${target}\` skill on the request below and follow it exactly,`,
      `as if the user had invoked \`$${target}\`. The abbreviation does not add, remove`,
      'or bypass any step or approval of that skill.',
      '',
    ].join('\n');
  }
  return [
    '---',
    `description: Shortcut for /${target} — AASC abbreviation`,
    'argument-hint: <prompt>',
    '---',
    '',
    `<!-- ${ALIAS_MARKER} -->`,
    '',
    kind === 'skill'
      ? `Use the \`${target}\` skill on the request below and follow it exactly.`
      : `Run the \`/${target}\` command with the arguments below.`,
    '',
    '$ARGUMENTS',
    '',
  ].join('\n');
}

type Existing = { exists: false } | { exists: true; ours: boolean; symlink: boolean };

function inspect(abs: string): Existing {
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    return { exists: false };
  }
  if (stat.isSymbolicLink()) return { exists: true, ours: false, symlink: true };
  if (!stat.isFile()) return { exists: true, ours: false, symlink: false };
  let text = '';
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return { exists: true, ours: false, symlink: false };
  }
  return { exists: true, ours: text.includes(ALIAS_MARKER), symlink: false };
}

function writeAtomic(abs: string, text: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.aasc-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: 0o644, flag: 'wx' });
    renameSync(tmp, abs);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export async function createAlias(req: AliasRequest, deps: AliasDeps = {}): Promise<AliasResult> {
  const home = deps.home ?? homedir();
  checkAbbr(req.abbr);
  if (!TARGET_RE.test(req.target)) throw new AliasError(400, 'The skill or command name is not valid.');
  if (req.agent !== 'claude' && req.agent !== 'codex' && req.agent !== 'shared') throw new AliasError(400, 'Unknown agent.');
  if (req.kind !== 'skill' && req.kind !== 'command') throw new AliasError(400, 'Unknown kind.');

  const files = aliasFilesFor(req.agent, req.kind, req.abbr, home);
  const scopes: ('claude' | 'codex')[] = req.agent === 'shared' ? ['claude', 'codex'] : [req.agent];
  for (const scope of scopes) {
    if (deps.realNames?.has(`${scope}:${req.abbr}`) || deps.realNames?.has(`shared:${req.abbr}`)) {
      throw new AliasError(409, `"${req.abbr}" is already the name of a skill or command, so an abbreviation would shadow it.`);
    }
  }

  // Check every file before writing any: all or nothing.
  const plan = files.map((file) => {
    if (!existsSync(file.cliHome)) {
      throw new AliasError(409, `${file.cli === 'claude' ? 'Claude Code' : 'Codex'} is not set up on this machine (no ${file.cli === 'claude' ? '~/.claude' : '~/.codex'}).`);
    }
    const found = inspect(file.abs);
    if (found.exists && !found.ours) {
      throw new AliasError(409, found.symlink
        ? `${file.display} is a symlink; AASC will not write through it.`
        : `${file.display} already exists and was not made by AASC; it was left alone.`);
    }
    const text = contentFor(file, req);
    const action: AliasAction = !found.exists ? 'created' : readFileSync(file.abs, 'utf8') === text ? 'unchanged' : 'updated';
    return { file, text, action };
  });

  for (const { file, text, action } of plan) {
    if (action !== 'unchanged') writeAtomic(file.abs, text);
  }
  return { files: plan.map(({ file, action }) => ({ path: file.display, action })) };
}

export async function removeAlias(
  req: { agent: AliasAgent; kind: AliasKind; abbr: string },
  deps: AliasDeps = {},
): Promise<AliasResult> {
  const home = deps.home ?? homedir();
  checkAbbr(req.abbr);
  const out: AliasResult['files'] = [];
  for (const file of aliasFilesFor(req.agent, req.kind, req.abbr, home)) {
    const found = inspect(file.abs);
    if (!found.exists) {
      out.push({ path: file.display, action: 'absent' });
    } else if (!found.ours) {
      out.push({ path: file.display, action: 'kept' });
    } else {
      rmSync(file.abs, { force: true });
      if (file.ownDir) {
        try {
          if (readdirSync(file.ownDir).length === 0) rmdirSync(file.ownDir);
        } catch {
          /* leave a folder we cannot read */
        }
      }
      out.push({ path: file.display, action: 'removed' });
    }
  }
  return { files: out };
}
