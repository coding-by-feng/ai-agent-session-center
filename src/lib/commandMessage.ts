/**
 * Slash-command / harness-plumbing transform for the CONVERSATION tab.
 *
 * Claude Code emits internal user messages wrapped in harness tags:
 *   <command-name>/clear</command-name>
 *   <command-message>…</command-message>
 *   <command-args>…</command-args>
 *   <local-command-stdout>…</local-command-stdout>
 *   <local-command-caveat>Caveat: … DO NOT respond …</local-command-caveat>
 *
 * Rendering these verbatim buries the real conversation under boilerplate.
 * `transformEntries` rewrites them into compact `command` chips (with any
 * `stdout` folded in) and collapses caveat/plumbing into `system` rows.
 */
import type { ConversationEntry } from './transcript';

const RE_COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const RE_COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const RE_STDOUT = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
const RE_CAVEAT = /<local-command-caveat>([\s\S]*?)<\/local-command-caveat>/;
const RE_ANY_TAG = /<command-name>|<local-command-caveat>|<local-command-stdout>/;

/** Cheap pre-check so non-command messages skip all regex work. */
function hasHarnessTag(text: string): boolean {
  return RE_ANY_TAG.test(text);
}

/**
 * Rewrite raw harness/plumbing user entries into `command` and `system`
 * entries. All other entries pass through unchanged and order is preserved.
 */
export function transformEntries(entries: ConversationEntry[]): ConversationEntry[] {
  const out: ConversationEntry[] = [];

  for (const entry of entries) {
    if (entry.role !== 'user' || !hasHarnessTag(entry.text)) {
      out.push(entry);
      continue;
    }

    const { text, timestamp } = entry;
    const name = text.match(RE_COMMAND_NAME)?.[1].trim();

    // A slash command (e.g. /clear, /effort) → compact chip, stdout folded in.
    if (name) {
      const args = text.match(RE_COMMAND_ARGS)?.[1].trim() || undefined;
      const stdout = text.match(RE_STDOUT)?.[1].trim() || undefined;
      out.push({ role: 'command', name, args, stdout, timestamp });
      continue;
    }

    // A standalone stdout block usually belongs to the command just above it
    // (same logical action, emitted as a separate message). Fold it in.
    const stdout = text.match(RE_STDOUT)?.[1].trim();
    const caveat = text.match(RE_CAVEAT)?.[1].trim();
    if (stdout && !caveat) {
      const last = out[out.length - 1];
      if (last && last.role === 'command' && !last.stdout) {
        out[out.length - 1] = { ...last, stdout };
        continue;
      }
      out.push({ role: 'system', text: stdout, timestamp });
      continue;
    }

    // Caveat boilerplate (or any leftover plumbing) → collapsible system row.
    out.push({ role: 'system', text: caveat ?? text.trim(), timestamp });
  }

  return out;
}
