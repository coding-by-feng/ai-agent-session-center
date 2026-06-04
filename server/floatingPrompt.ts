/**
 * Pure prompt-building for floating "fork" sessions.
 *
 * Extracted from floatingSessionSpawner.ts so the prompt synthesis + labels can
 * be unit-tested WITHOUT importing the session/db/pty module graph (which pulls
 * in better-sqlite3 and cannot load under the test worker's Node ABI). This
 * module imports nothing but types.
 */

export type FloatingMode =
  | 'explain-learning'
  | 'explain-native'
  | 'translate-selection-learning'
  | 'translate-selection-native'
  | 'translate-answer'
  | 'translate-file'
  // User supplies the instruction; it's combined with the selected text to
  // start a fresh floating session. Selection-anchored, never inherits context.
  | 'custom';

export interface SpawnFloatingArgs {
  originSessionId: string;
  mode: FloatingMode;
  selection?: string;
  contextLine?: string;
  fileContent?: string;
  filePath?: string;
  /** Free-form instruction for the `custom` mode (combined with `selection`). */
  customPrompt?: string;
  nativeLanguage: string;
  learningLanguage: string;
  /**
   * When true and the origin is a Claude/Codex session, explain-* modes fork
   * the prior conversation. Translate-* and custom modes ignore this (they're
   * self-contained). Defaults to true client-side.
   */
  inheritContext?: boolean;
}

/** 256KB safety cap; well under typical ARG_MAX. */
export const MAX_PROMPT_BYTES = 256 * 1024;

/** Human label for the floating window header. `custom` is generic here — the
 *  spawner overrides it with a prompt-derived snippet via {@link customFloatLabel}. */
export function floatLabel(mode: FloatingMode, native: string, learning: string): string {
  switch (mode) {
    case 'explain-learning': return `Explain (${learning})`;
    case 'explain-native': return `Explain (${native})`;
    case 'translate-selection-learning': return `Translate → ${learning}`;
    case 'translate-selection-native': return `Translate → ${native}`;
    case 'translate-answer': return `Translate answer → ${native}`;
    case 'translate-file': return `Translate file → ${native}`;
    case 'custom': return 'Custom';
  }
}

/** Derive a short, single-line window label from a custom prompt. */
export function customFloatLabel(customPrompt: string): string {
  const oneLine = customPrompt.trim().replace(/\s+/g, ' ');
  if (!oneLine) return 'Custom';
  const snippet = oneLine.length > 24 ? `${oneLine.slice(0, 24)}…` : oneLine;
  return `Custom: ${snippet}`;
}

/**
 * Build the prompt string fed to the CLI for a given mode. Returns null when a
 * mode's required input is missing, so the caller can reject with a clear error.
 */
export function buildPrompt(args: SpawnFloatingArgs, prevAnswer: string | null): string | null {
  const { mode, selection, contextLine, fileContent, filePath, customPrompt, nativeLanguage, learningLanguage } = args;
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

    case 'translate-selection-learning':
      if (!selection) return null;
      return [
        `Translate the following text into ${learningLanguage}.`,
        `Output ONLY the translation — no explanations, no notes, no surrounding quotes.`,
        `Preserve original formatting (line breaks, code, lists, markdown).`,
        ``,
        `"""`,
        selection,
        `"""`,
      ].join('\n');

    case 'translate-selection-native':
      if (!selection) return null;
      return [
        `Translate the following text into ${nativeLanguage}.`,
        `Output ONLY the translation — no explanations, no notes, no surrounding quotes.`,
        `Preserve original formatting (line breaks, code, lists, markdown).`,
        ``,
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

    case 'custom': {
      // The user's own instruction leads; the selected text follows in a fence.
      // Both are required — this mode is anchored to a selection.
      if (!selection || !customPrompt || !customPrompt.trim()) return null;
      const parts: string[] = [customPrompt.trim(), ``];
      if (contextLine && contextLine.trim()) {
        parts.push(`Surrounding line: "${contextLine.trim()}"`);
      }
      parts.push(`Selected text:`, `"""`, selection, `"""`);
      return parts.join('\n');
    }
  }
}
