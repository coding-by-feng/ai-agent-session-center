/**
 * Spawn a floating "fork" session pre-loaded with a synthesized prompt.
 *
 * Reuses the existing fork mechanism (createTerminal + createTerminalSession +
 * writeWhenReady) — the only addition is building a prompt string from the
 * caller's mode + selection/file content and feeding it to the CLI as a
 * positional argument.
 *
 * Modes (prompt synthesis + labels live in ./floatingPrompt.ts):
 *   explain-learning             — explain the selected text in the learning lang
 *   explain-native               — explain the selected text in the native lang
 *   translate-selection-learning — direct translation of the selection → learning
 *   translate-selection-native   — direct translation of the selection → native
 *   translate-answer             — translate the origin's last assistant message → native
 *   translate-file               — translate the supplied file content → native
 *   custom                       — user's own instruction + the selection → fresh session
 *
 * For `translate-answer`, the previous assistant message is read from the
 * Claude transcript file (server/extractPreviousAnswer.ts). Cross-CLI support
 * for codex/gemini transcripts is a phase-2 follow-up.
 */
import { getSession, getSessionByTerminalId, createTerminalSession } from './sessionStore.js';
import { createTerminal, consumePendingLink, writeWhenReady } from './sshManager.js';
import { readClaudeLastAssistant } from './extractPreviousAnswer.js';
import { reconstructPermissionFlags } from './config.js';
import {
  buildPrompt,
  floatLabel,
  customFloatLabel,
  MAX_PROMPT_BYTES,
  type SpawnFloatingArgs,
} from './floatingPrompt.js';
import log from './logger.js';
import type { TerminalConfig } from '../src/types/terminal.js';

// Re-exported so existing importers (apiRouter) keep their import paths.
export type { FloatingMode, SpawnFloatingArgs } from './floatingPrompt.js';

export interface SpawnFloatingResult {
  terminalId: string;
  label: string;
}

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

/** Build a Claude/Codex fork-launch command that inherits the origin's history.
 *  - If `originSessionId` looks like a real CLI session id, pin to it.
 *  - Otherwise (e.g. dashboard `term-…` placeholder), fork the most recent
 *    session in the cwd.
 */
function buildForkCommand(cli: 'claude' | 'codex', originSessionId: string, prompt: string): string {
  const escapedPrompt = shellEscapeSingle(prompt);
  const isInternalId = originSessionId.startsWith('term-');
  const safeId = /^[a-zA-Z0-9_\-]+$/.test(originSessionId) ? originSessionId : '';
  if (cli === 'codex') {
    if (safeId && !isInternalId) {
      return `codex fork '${safeId}' '${escapedPrompt}'`;
    }
    return `codex fork --last '${escapedPrompt}'`;
  }
  if (safeId && !isInternalId) {
    return `claude --resume '${safeId}' --fork-session '${escapedPrompt}'`;
  }
  return `claude --continue --fork-session '${escapedPrompt}'`;
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
    const cliKind = detectCli(origin.startupCommand || origin.sshCommand || origin.sshConfig?.command);
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
  const cliKind = detectCli(origin.startupCommand || origin.sshCommand || origin.sshConfig?.command);
  // Inherit the prior conversation only for explain-* modes on Claude/Codex origins.
  // translate-* and custom modes are self-contained — the prompt carries everything.
  const shouldInheritContext = (
    args.inheritContext !== false &&
    (cliKind === 'claude' || cliKind === 'codex') &&
    (args.mode === 'explain-learning' || args.mode === 'explain-native')
  );
  // Recursive fork: a popup spawned from inside a floating terminal forks from
  // that terminal's session — resolved here from spawnTerminalId — so context
  // chains down (root → A → B → …). Selections without a host terminal (e.g. the
  // project-tab markdown viewer) have no spawnTerminalId and fork from the root.
  const spawnParent = args.spawnTerminalId ? getSessionByTerminalId(args.spawnTerminalId) : null;
  const forkParentId = spawnParent ? spawnParent.sessionId : args.originSessionId;
  const baseLaunchCmd = shouldInheritContext
    ? buildForkCommand(cliKind === 'codex' ? 'codex' : 'claude', forkParentId, prompt)
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

  const label = args.mode === 'custom'
    ? customFloatLabel(args.customPrompt || '')
    : floatLabel(args.mode, args.nativeLanguage, args.learningLanguage);
  await createTerminalSession(terminalId, {
    ...newConfig,
    command: launchCmd,
    sessionTitle: `${label} · ${origin.title || origin.projectName || 'session'}`.slice(0, 200),
    isFork: true,
    originSessionId: args.originSessionId,
  });

  let prefix = '';
  if (isSsh && cfg!.host && cfg!.host !== 'localhost' && cfg!.host !== '127.0.0.1') {
    prefix += `export AGENT_MANAGER_TERMINAL_ID='${terminalId}' && `;
    if (cfg!.workingDir) {
      prefix += `cd '${shellEscapeSingle(cfg!.workingDir)}' && `;
    }
  }
  writeWhenReady(terminalId, `${prefix}${launchCmd}\r`);

  log.info('floating-spawn', `Spawned ${args.mode} float (terminalId=${terminalId}, cli=${cliKind}, originSession=${origin.sessionId}, forkParent=${forkParentId}, inheritContext=${shouldInheritContext})`);

  return { terminalId, label };
}
