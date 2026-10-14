/**
 * floatingSpawn — ask the server for an AI popup (a floating fork) from a text
 * selection, and record it for the AI POPUPS history (AASC-20: the phone's
 * Conversation tab). The desktop's SelectionPopup builds the same request
 * inline, around its window placement; a phone has no window to place, so the
 * request and its log row are all there is to share.
 */
import { createLog } from './translationLog';

export type SelectionSpawnMode =
  | 'explain-learning'
  | 'explain-native'
  | 'vocab-native'
  | 'translate-selection-learning'
  | 'translate-selection-native'
  | 'custom';

export interface FloatingSpawnRequest {
  originSessionId: string;
  mode: SelectionSpawnMode;
  selection: string;
  contextLine?: string;
  customPrompt?: string;
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

/** The server's caps (spawn-floating's Zod schema); longer text is cut, not refused. */
const MAX_SELECTION = 64 * 1024;
const MAX_CONTEXT = 2 * 1024;

/** POST /api/sessions/spawn-floating. Throws an Error with the server's words on failure. */
export async function requestFloatingSpawn(req: FloatingSpawnRequest): Promise<FloatingSpawnResult> {
  const res = await fetch('/api/sessions/spawn-floating', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...req,
      selection: req.selection.slice(0, MAX_SELECTION),
      contextLine: req.contextLine?.slice(0, MAX_CONTEXT),
      customPrompt: req.mode === 'custom' ? req.customPrompt : undefined,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<FloatingSpawnResult> & { error?: string };
  if (!res.ok || typeof data.terminalId !== 'string') {
    throw new Error(data.error || (res.status === 404 ? 'This session is not shared with this device' : 'Could not start the AI popup'));
  }
  return { terminalId: data.terminalId, label: data.label || 'AI popup' };
}

/** The AI POPUPS row for a popup just started. Failing to save it never fails the popup. */
export async function logFloatingSpawn(
  req: FloatingSpawnRequest,
  result: FloatingSpawnResult,
  origin: { projectName?: string; title?: string } | undefined,
): Promise<void> {
  await createLog({
    mode: req.mode,
    nativeLanguage: req.nativeLanguage,
    learningLanguage: req.learningLanguage,
    selection: req.selection,
    contextLine: req.contextLine ?? '',
    filePath: '',
    fileContent: '',
    prompt: req.mode === 'custom' ? req.customPrompt ?? '' : '',
    originSessionId: req.originSessionId,
    originProjectName: origin?.projectName ?? '',
    originSessionTitle: origin?.title ?? '',
    floatTerminalId: result.terminalId,
  }).catch(() => { /* persistence failure is non-fatal */ });
}
