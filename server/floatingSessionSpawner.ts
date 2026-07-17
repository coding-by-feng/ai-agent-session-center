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
import { createTerminal, consumePendingLink, writeWhenReady, injectClaudeCommandsWhenReady } from './sshManager.js';
import { readClaudeLastAssistant } from './extractPreviousAnswer.js';
import { reconstructPermissionFlags, applyClaudeLaunchFlags, sanitizeModelId } from './config.js';
import {
  buildPrompt,
  floatLabel,
  customFloatLabel,
  MAX_PROMPT_BYTES,
  type SpawnFloatingArgs,
} from './floatingPrompt.js';
import log from './logger.js';
import type { TerminalConfig } from '../src/types/terminal.js';
import type { Session } from '../src/types/session.js';

// Re-exported so existing importers (apiRouter) keep their import paths.
export type { FloatingMode, SpawnFloatingArgs } from './floatingPrompt.js';

export interface SpawnFloatingResult {
  terminalId: string;
  label: string;
}

function shellEscapeSingle(value: string): string {
  return value.replace(/'/g, `'"'"'`);
}

type CliKind = 'claude' | 'codex' | 'gemini';

/** Sniff a CLI family from a launch command string (tolerates a leading path). */
function detectCliFromCommand(command: string | undefined | null): CliKind | null {
  const cmd = (command || '').toLowerCase().trim();
  if (/^(?:\S*\/)?codex(?:\s|$)/.test(cmd)) return 'codex';
  if (/^(?:\S*\/)?gemini(?:\s|$)/.test(cmd)) return 'gemini';
  if (/^(?:\S*\/)?claude(?:\s|$)/.test(cmd)) return 'claude';
  return null;
}

/** Sniff a CLI family from a model id (e.g. gpt-5 → codex, gemini-2 → gemini).
 *  Keyword set + order mirror the canonical client detector (src/lib/cliDetect.ts)
 *  to avoid backend/frontend divergence. */
function detectCliFromModel(model: string | undefined | null): CliKind | null {
  const m = (model || '').toLowerCase();
  if (!m) return null;
  if (m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) return 'claude';
  if (m.includes('gemini') || m.includes('gemma')) return 'gemini';
  if (m.includes('gpt') || m.includes('codex') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 'codex';
  return null;
}

/**
 * Resolve which AI CLI an origin session is running so the popup spawns the same
 * one as its parent. Precedence mirrors the canonical client detector
 * (src/lib/cliDetect.ts):
 *   1. cliSource — authoritative (codex/gemini hooks set it; inferCliSource fills it otherwise)
 *   2. launch command string
 *   3. model id
 * Falls back to 'claude' when nothing matches (the historical default).
 */
export function resolveOriginCli(origin: Pick<Session, 'cliSource' | 'startupCommand' | 'sshCommand' | 'sshConfig' | 'model'>): CliKind {
  const explicit = (origin.cliSource || '').toLowerCase();
  if (explicit === 'claude' || explicit === 'codex' || explicit === 'gemini') return explicit;
  return (
    detectCliFromCommand(origin.startupCommand || origin.sshCommand || origin.sshConfig?.command) ||
    detectCliFromModel(origin.model) ||
    'claude'
  );
}

function buildLaunchCommand(cli: CliKind, prompt: string): string {
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
    const cliKind = resolveOriginCli(origin);
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

  // Spawn the same CLI as the origin session (prefers the authoritative
  // cliSource so codex/gemini parents aren't misdetected as claude).
  const cliKind = resolveOriginCli(origin);
  // Recursive fork: a popup spawned from inside a floating terminal forks from
  // that terminal's session — resolved here from spawnTerminalId — so context
  // chains down (root → A → B → …). Selections without a host terminal (e.g. the
  // project-tab markdown viewer) have no spawnTerminalId and fork from the root.
  const spawnParent = args.spawnTerminalId ? getSessionByTerminalId(args.spawnTerminalId) : null;
  const forkParentSession = spawnParent ?? origin;
  const forkParentId = spawnParent ? spawnParent.sessionId : args.originSessionId;
  // Fork from (inherit the conversation context of) the parent session for ALL
  // popup modes on Claude/Codex origins — surrounding context improves
  // explanations, translations, and vocab sense. BUT only when that parent has a
  // resumable conversation: a brand-new session with no prompts yet has no
  // transcript, so `claude --resume <id> --fork-session` fails with "No
  // conversation found" — fall back to a fresh launch (the popup prompt is
  // self-contained anyway). Gemini has no fork (stays fresh); an explicit
  // inheritContext:false (the Settings toggle) opts out.
  const parentHasConversation = (forkParentSession?.promptHistory?.length ?? 0) > 0;
  const shouldInheritContext = (
    args.inheritContext !== false &&
    (cliKind === 'claude' || cliKind === 'codex') &&
    parentHasConversation
  );
  const baseLaunchCmd = shouldInheritContext
    ? buildForkCommand(cliKind === 'codex' ? 'codex' : 'claude', forkParentId, prompt)
    : buildLaunchCommand(cliKind, prompt);
  const permsCmd = cliKind === 'claude'
    ? reconstructPermissionFlags(baseLaunchCmd, origin.permissionMode)
    : baseLaunchCmd;
  // Inherit the parent's model + effort as launch flags so they apply before the
  // popup's first prompt runs. ultracode launches as `--effort xhigh` (its valid
  // base) and is upgraded to true ultracode via the slash injection below.
  const launchCmd = applyClaudeLaunchFlags(permsCmd, origin.model, origin.effortLevel);

  const cfg = origin.sshConfig;
  const isSsh = !!(cfg && cfg.username);
  // Inherit model/effort/characterModel from the origin so the popup matches the
  // parent (also persisted onto the popup's session for display + recursive forks).
  // Sanitize the inherited model so a contaminated origin (e.g. a stripped-ANSI
  // `claude-opus-4-8[1m]` from an older session) doesn't propagate down the fork
  // chain or get persisted/displayed on the popup.
  const inherit = {
    model: sanitizeModelId(origin.model) || undefined,
    effortLevel: origin.effortLevel,
    characterModel: origin.characterModel,
  };
  const newConfig: TerminalConfig = isSsh
    ? { ...cfg!, workingDir: cfg!.workingDir || '~', command: '', ...inherit }
    : { host: 'localhost', workingDir: origin.projectPath || '~', command: '', ...inherit };

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
    isFloating: true,
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

  // ultracode launches as `--effort xhigh` (above); upgrade it to true ultracode
  // via /effort once Claude Code is ready (the raw flag rejects `ultracode`).
  if (cliKind === 'claude' && origin.effortLevel === 'ultracode') {
    injectClaudeCommandsWhenReady(terminalId, ['/effort ultracode']);
  }

  log.info('floating-spawn', `Spawned ${args.mode} float (terminalId=${terminalId}, cli=${cliKind}, originSession=${origin.sessionId}, originModel=${origin.model || '-'}, originEffort=${origin.effortLevel || '-'}, forkParent=${forkParentId}, inheritContext=${shouldInheritContext})`);

  return { terminalId, label };
}
