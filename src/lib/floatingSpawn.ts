/**
 * floatingSpawn — ask the server for an AI popup (a floating fork), and record
 * it for the AI POPUPS / REVIEW history (AASC-20: the phone's Conversation tab;
 * AASC-57: every desktop mode, from Chat, the Terminal and a project file).
 *
 * The desktop's SelectionPopup builds the same request inline, around its window
 * placement; a phone has no window to place, so the request, the choices a
 * source offers and the log row are all there is to share. Pure apart from the
 * fetch and the Dexie write, so each mode's payload is testable on its own.
 */
import { createLog } from './translationLog';

/** The modes a text selection starts (the desktop popup's six buttons). */
export type SelectionSpawnMode =
  | 'explain-learning'
  | 'explain-native'
  | 'vocab-native'
  | 'translate-selection-learning'
  | 'translate-selection-native'
  | 'custom';

/** Every mode the server's spawn route takes (server/floatingPrompt.ts `FloatingMode`). */
export type FloatingSpawnMode = SelectionSpawnMode | 'translate-answer' | 'translate-file';

export const SELECTION_MODES: readonly SelectionSpawnMode[] = [
  'explain-learning',
  'explain-native',
  'translate-selection-learning',
  'translate-selection-native',
  'vocab-native',
  'custom',
];

/**
 * Where the text came from:
 * - chat      the session's Chat (forks the session)
 * - terminal  the session's terminal (forks the session of `spawnTerminalId`, as the desktop's terminal does)
 * - file      a project file (forks the session; `filePath` absolute, `fileContent` its text when it has one)
 * - popup     an AI popup's own answer (forks the popup: `spawnTerminalId` is the popup's terminal)
 */
export type AiSourceKind = 'chat' | 'terminal' | 'file' | 'popup';

export interface AiSource {
  kind: AiSourceKind;
  spawnTerminalId?: string;
  filePath?: string;
  fileContent?: string;
}

export interface FloatingSpawnRequest {
  /** The ROOT session: cwd, CLI and (client side) which session the popup shows under. */
  originSessionId: string;
  /** The terminal the text came from: the server forks that terminal's session instead. */
  spawnTerminalId?: string;
  mode: FloatingSpawnMode;
  selection?: string;
  contextLine?: string;
  customPrompt?: string;
  filePath?: string;
  fileContent?: string;
  nativeLanguage: string;
  learningLanguage: string;
  inheritContext?: boolean;
  model?: string;
  effortLevel?: string;
}

export interface FloatingSpawnResult {
  terminalId: string;
  label: string;
}

/** The popup quick settings and languages a spawn reads (settingsStore). */
export interface SpawnSettings {
  nativeLanguage: string;
  learningLanguage: string;
  inheritContext: boolean;
  /** Claude model override ('' inherits the origin's). */
  model: string;
  /** Codex model override ('' inherits the origin's). */
  codexModel: string;
  /** Claude effort override ('' inherits the origin's). */
  effort: string;
}

/** The server's caps (spawn-floating's Zod schema); longer text is cut, not refused. */
const MAX_SELECTION = 64 * 1024;
const MAX_CONTEXT = 2 * 1024;
/**
 * A file a phone may send for translation. The route takes 256 KB of content and the
 * whole prompt must stay under 256 KB (MAX_PROMPT_BYTES), so leave room for the
 * instruction around it.
 */
export const MAX_TRANSLATE_FILE_BYTES = 240 * 1024;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

const isExplain = (mode: FloatingSpawnMode): boolean => mode === 'explain-learning' || mode === 'explain-native';

export interface BuildSpawnInput {
  originSessionId: string;
  cli: 'claude' | 'codex';
  mode: FloatingSpawnMode;
  source: AiSource;
  selection?: { text: string; contextLine?: string } | null;
  customPrompt?: string;
  /** Explain from a file: name the file in the prompt (the desktop's "Attach file path?"). */
  attachFilePath?: boolean;
  settings: SpawnSettings;
}

/** The spawn request for one mode from one source, as the desktop's popup builds it. */
export function buildFloatingSpawnRequest(input: BuildSpawnInput): FloatingSpawnRequest {
  const { mode, source, settings, cli } = input;
  const usesSelection = (SELECTION_MODES as readonly string[]).includes(mode);
  const custom = input.customPrompt?.trim();
  return {
    originSessionId: input.originSessionId,
    ...(source.spawnTerminalId ? { spawnTerminalId: source.spawnTerminalId } : {}),
    mode,
    ...(usesSelection && input.selection ? { selection: input.selection.text } : {}),
    ...(usesSelection && input.selection?.contextLine ? { contextLine: input.selection.contextLine } : {}),
    ...(mode === 'custom' && custom ? { customPrompt: custom } : {}),
    ...(mode === 'translate-file' && source.filePath ? { filePath: source.filePath } : {}),
    ...(mode === 'translate-file' && source.fileContent ? { fileContent: source.fileContent } : {}),
    ...(isExplain(mode) && input.attachFilePath && source.filePath ? { filePath: source.filePath } : {}),
    nativeLanguage: settings.nativeLanguage,
    learningLanguage: settings.learningLanguage,
    inheritContext: settings.inheritContext,
    // Blank inherits the origin's own model/effort, as on the desktop. Codex has no effort.
    model: (cli === 'codex' ? settings.codexModel : settings.model) || undefined,
    effortLevel: cli === 'claude' ? settings.effort || undefined : undefined,
  };
}

export interface AiActionState {
  offered: boolean;
  /** Offered but can't run from here, and why (shown under the button). */
  disabledReason?: string;
}

/**
 * Which modes a source offers. A selection offers the desktop popup's six; the
 * session's Chat and Terminal also offer its last answer (Claude and Codex: the Mac reads
 * it from the transcript or rollout); a project file offers the whole file.
 */
export function aiActionsFor(input: {
  source: AiSource;
  cli: 'claude' | 'codex' | null;
  hasSelection: boolean;
}): Record<FloatingSpawnMode, AiActionState> {
  const { source, cli, hasSelection } = input;
  const selection: AiActionState = { offered: hasSelection };
  const answerOffered = source.kind === 'chat' || source.kind === 'terminal';
  const content = source.fileContent;
  const fileReason = !content
    ? 'Only a text file can be translated whole.'
    : utf8Bytes(content) > MAX_TRANSLATE_FILE_BYTES
      ? 'This file is too long to translate whole (over 240 KB). Select a part of it instead.'
      : undefined;
  return {
    'explain-learning': selection,
    'explain-native': selection,
    'vocab-native': selection,
    'translate-selection-learning': selection,
    'translate-selection-native': selection,
    custom: selection,
    'translate-answer': {
      offered: answerOffered,
      ...(answerOffered && cli !== 'claude' && cli !== 'codex'
        ? { disabledReason: 'Claude Code and Codex only: your Mac reads the answer from the session’s transcript.' }
        : {}),
    },
    'translate-file': {
      offered: source.kind === 'file',
      ...(source.kind === 'file' && fileReason ? { disabledReason: fileReason } : {}),
    },
  };
}

/** POST /api/sessions/spawn-floating. Throws an Error with the server's words on failure. */
export async function requestFloatingSpawn(req: FloatingSpawnRequest): Promise<FloatingSpawnResult> {
  const res = await fetch('/api/sessions/spawn-floating', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...req,
      selection: req.selection?.slice(0, MAX_SELECTION),
      contextLine: req.contextLine?.slice(0, MAX_CONTEXT),
      customPrompt: req.mode === 'custom' ? req.customPrompt : undefined,
      fileContent: req.mode === 'translate-file' ? req.fileContent : undefined,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<FloatingSpawnResult> & { error?: string };
  if (!res.ok || typeof data.terminalId !== 'string') {
    throw new Error(data.error || (res.status === 404 ? 'This session is not shared with this device' : 'Could not start the AI popup'));
  }
  return { terminalId: data.terminalId, label: data.label || 'AI popup' };
}

/** The AI POPUPS / REVIEW row for a popup just started. Failing to save it never fails the popup. */
export async function logFloatingSpawn(
  req: FloatingSpawnRequest,
  result: FloatingSpawnResult,
  origin: { projectName?: string; title?: string } | undefined,
  sourceFilePath = '',
): Promise<void> {
  await createLog({
    mode: req.mode,
    nativeLanguage: req.nativeLanguage,
    learningLanguage: req.learningLanguage,
    selection: req.selection ?? '',
    contextLine: req.contextLine ?? '',
    filePath: req.filePath ?? '',
    // Where the text came from, so a favourite can be found again in its file.
    sourceFilePath,
    fileContent: req.mode === 'translate-file' ? req.fileContent ?? '' : '',
    prompt: req.mode === 'custom' ? req.customPrompt ?? '' : '',
    originSessionId: req.originSessionId,
    originProjectName: origin?.projectName ?? '',
    originSessionTitle: origin?.title ?? '',
    floatTerminalId: result.terminalId,
  }).catch(() => { /* persistence failure is non-fatal */ });
}
