/**
 * Spawn a floating "fork" session pre-loaded with a synthesized prompt.
 *
 * Reuses the existing fork mechanism (createTerminal + createTerminalSession +
 * writeWhenReady) — the only addition is building a prompt string from the
 * caller's mode + selection/file content and feeding it to the CLI as a
 * positional argument.
 *
 * Modes:
 *   explain-learning    — explain the selected text in the user's learning lang
 *   explain-native      — explain the selected text in the user's native lang
 *   translate-answer    — translate the origin's last assistant message → native
 *   translate-file      — translate the supplied file content → native
 *
 * For `translate-answer`, the previous assistant message is read from the
 * Claude transcript file (server/extractPreviousAnswer.ts). Cross-CLI support
 * for codex/gemini transcripts is a phase-2 follow-up.
 */
import { getSession, createTerminalSession } from './sessionStore.js';
import { createTerminal, consumePendingLink, writeWhenReady } from './sshManager.js';
import { readClaudeLastAssistant } from './extractPreviousAnswer.js';
import { reconstructPermissionFlags } from './config.js';
import log from './logger.js';
import type { TerminalConfig } from '../src/types/terminal.js';

export type FloatingMode =
  | 'explain-learning'
  | 'explain-native'
  | 'translate-answer'
  | 'translate-file';

export interface SpawnFloatingArgs {
  originSessionId: string;
  mode: FloatingMode;
  selection?: string;
  contextLine?: string;
  fileContent?: string;
  filePath?: string;
  nativeLanguage: string;
  learningLanguage: string;
  /**
   * When true and the origin is a Claude session, explain-* modes use
   *   claude --resume '<id>' --fork-session '<prompt>'
   * so the AI inherits the prior conversation. Translate-* modes ignore this
   * (they're self-contained). Defaults to true client-side.
   */
  inheritContext?: boolean;
}

export interface SpawnFloatingResult {
  terminalId: string;
  label: string;
}

const MAX_PROMPT_BYTES = 256 * 1024; // 256KB safety cap; well under typical ARG_MAX

function shellEscapeSingle(value: string): string {
  return value.replace(/'/g, `'"'"'`);
}

function detectCli(startupCommand: string | undefined | null): 'claude' | 'codex' | 'gemini' {
  const cmd = (startupCommand || '').toLowerCase().trim();
  if (cmd.startsWith('codex')) return 'codex';
  if (cmd.startsWith('gemini')) return 'gemini';
  return 'claude';
}

function buildLaunchCommand(cli: 'claude' | 'codex' | 'gemini', prompt: string): string {
  const escaped = shellEscapeSingle(prompt);
  // Claude/Codex accept a positional prompt; Gemini uses -p.
  if (cli === 'gemini') return `gemini -p '${escaped}'`;
  return `${cli} '${escaped}'`;
}

/** Build a Claude fork-launch command that inherits the origin's history.
 *  - If `originSessionId` looks like a real Claude UUID, pin to it via --resume.
 *  - Otherwise (e.g. dashboard `term-…` placeholder), fall back to --continue
 *    --fork-session, which forks from the most-recent session in the cwd.
 */
function buildClaudeForkCommand(originSessionId: string, prompt: string): string {
  const escapedPrompt = shellEscapeSingle(prompt);
  const isInternalId = originSessionId.startsWith('term-');
  const safeId = /^[a-zA-Z0-9_\-]+$/.test(originSessionId) ? originSessionId : '';
  if (safeId && !isInternalId) {
    return `claude --resume '${safeId}' --fork-session '${escapedPrompt}'`;
  }
  return `claude --continue --fork-session '${escapedPrompt}'`;
}

function floatLabel(mode: FloatingMode, native: string, learning: string): string {
  switch (mode) {
    case 'explain-learning': return `Explain (${learning})`;
    case 'explain-native': return `Explain (${native})`;
    case 'translate-answer': return `Translate answer → ${native}`;
    case 'translate-file': return `Translate file → ${native}`;
  }
}

function buildPrompt(args: SpawnFloatingArgs, prevAnswer: string | null): string | null {
  const { mode, selection, contextLine, fileContent, filePath, nativeLanguage, learningLanguage } = args;
  const ctx = contextLine && contextLine.trim()
    ? `Surrounding line: "${contextLine.trim()}"\n`
    : '';

  switch (mode) {
    case 'explain-learning':
      if (!selection) return null;
      return [
        `Explain the following in ${learningLanguage}. Cover meaning, nuance, related concepts, and short examples. Be concise.`,
        ctx,
        `Selected text:`,
        `"""`,
        selection,
        `"""`,
      ].join('\n');

    case 'explain-native':
      if (!selection) return null;
      return [
        `Explain the following in ${nativeLanguage}. Use ${nativeLanguage} for the explanation. Cover meaning, nuance, and any technical concepts. Be concise.`,
        ctx,
        `Selected text:`,
        `"""`,
        selection,
        `"""`,
      ].join('\n');

    case 'translate-answer':
      if (!prevAnswer) return null;
      return [
        `Translate the following text into ${nativeLanguage}. Preserve markdown, code blocks, lists, and structure. Output translation only, no commentary.`,
        `"""`,
        prevAnswer,
        `"""`,
      ].join('\n');

    case 'translate-file': {
      if (!fileContent) return null;
      const fp = filePath ? `\nFile: ${filePath}` : '';
      return [
        `Translate the following markdown file into ${nativeLanguage}. Preserve markdown syntax exactly (headings, code blocks, lists, links, images, tables). Output translation only.${fp}`,
        `"""`,
        fileContent,
        `"""`,
      ].join('\n');
    }
  }
}

/**
 * Build a new floating terminal session pre-loaded with the synthesized prompt.
 *
 * Throws on bad input (missing origin, bad mode payload, prompt too large) — the
 * caller is responsible for surfacing the error to the client.
 */
export async function spawnFloatingSession(args: SpawnFloatingArgs): Promise<SpawnFloatingResult> {
  const origin = getSession(args.originSessionId);
  if (!origin) {
    throw new Error(`Origin session not found: ${args.originSessionId}`);
  }

  // Resolve previous answer (only for translate-answer)
  let prevAnswer: string | null = null;
  if (args.mode === 'translate-answer') {
    const projectPath = origin.projectPath || '';
    const cliKind = detectCli(origin.startupCommand);
    if (cliKind === 'claude' && projectPath) {
      prevAnswer = readClaudeLastAssistant(
        origin.sessionId || null,
        projectPath,
        origin.transcriptPath || null,
      );
    }
    if (!prevAnswer) {
      throw new Error('Could not read the previous assistant answer for this session. Translation requires a Claude Code transcript.');
    }
  }

  const prompt = buildPrompt(args, prevAnswer);
  if (!prompt) {
    throw new Error(`Cannot build prompt for mode "${args.mode}" — required input is missing.`);
  }

  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > MAX_PROMPT_BYTES) {
    throw new Error(`Prompt is too large (${(promptBytes / 1024).toFixed(0)}KB > ${MAX_PROMPT_BYTES / 1024}KB cap). Try selecting a smaller portion.`);
  }

  // Spawn the same CLI as the origin session.
  const cliKind = detectCli(origin.startupCommand);
  // Inherit the prior conversation only for explain-* modes on Claude origins.
  // translate-* modes are self-contained — the answer/file is in the prompt.
  const shouldInheritContext = (
    args.inheritContext !== false &&
    cliKind === 'claude' &&
    (args.mode === 'explain-learning' || args.mode === 'explain-native')
  );
  const baseLaunchCmd = shouldInheritContext
    ? buildClaudeForkCommand(args.originSessionId, prompt)
    : buildLaunchCommand(cliKind, prompt);
  const launchCmd = cliKind === 'claude'
    ? reconstructPermissionFlags(baseLaunchCmd, origin.permissionMode)
    : baseLaunchCmd;

  const cfg = origin.sshConfig;
  const isSsh = !!(cfg && cfg.username);
  const newConfig: TerminalConfig = isSsh
    ? { ...cfg!, workingDir: cfg!.workingDir || '~', command: '' }
    : { host: 'localhost', workingDir: origin.projectPath || '~', command: '' };

  const terminalId = await createTerminal(newConfig, null);
  consumePendingLink(newConfig.workingDir || origin.projectPath || '');

  const label = floatLabel(args.mode, args.nativeLanguage, args.learningLanguage);
  await createTerminalSession(terminalId, {
    ...newConfig,
    command: launchCmd,
    sessionTitle: `${label} · ${origin.title || origin.projectName || 'session'}`.slice(0, 200),
  });

  let prefix = '';
  if (isSsh && cfg!.host && cfg!.host !== 'localhost' && cfg!.host !== '127.0.0.1') {
    prefix += `export AGENT_MANAGER_TERMINAL_ID='${terminalId}' && `;
    if (cfg!.workingDir) {
      prefix += `cd '${shellEscapeSingle(cfg!.workingDir)}' && `;
    }
  }
  writeWhenReady(terminalId, `${prefix}${launchCmd}\r`);

  log.info('floating-spawn', `Spawned ${args.mode} float (terminalId=${terminalId}, cli=${cliKind}, originSession=${origin.sessionId}, inheritContext=${shouldInheritContext})`);

  return { terminalId, label };
}
