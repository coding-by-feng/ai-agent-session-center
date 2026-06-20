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
 * It ALSO injects content into `user`-role turns that the user never typed —
 * skill bodies ("Base directory for this skill: …"), `<system-reminder>` blocks,
 * and SessionStart/hook additional-context. Rendering all of this verbatim as
 * "USER" buries the real prompts. `transformEntries` rewrites slash commands
 * into compact `command` chips and demotes every flavour of injected content
 * into labelled, collapsible `system` rows so genuine user prompts stand alone.
 */
import type { ConversationEntry, SystemKind } from './transcript';

const RE_COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const RE_COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const RE_STDOUT = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
const RE_CAVEAT = /<local-command-caveat>([\s\S]*?)<\/local-command-caveat>/;
const RE_ANY_TAG = /<command-name>|<local-command-caveat>|<local-command-stdout>/;

// ---- Non-tagged injected content (arrives with a plain `user` role) ----
// Anchored at the start of the message (leading whitespace tolerated via `^\s*`,
// so no full-body trim/clone is needed) to avoid misclassifying a genuine user
// prompt that merely mentions one of these strings.
const RE_SKILL_BODY = /^\s*Base directory for this skill:\s*(\S+)/;
const RE_SKILL_INTRO = /full content of (?:your|the) ['"]([^'"]+)['"] skill/i;
const RE_SYSTEM_REMINDER = /^\s*<system-reminder>/;
const RE_HOOK_CONTEXT = /^\s*(?:<(?:EXTREMELY_IMPORTANT|IMPORTANT|SYSTEM)[^>]*>|SessionStart hook|[A-Za-z]+ hook additional context)/;

/** Cheap pre-check so non-command messages skip all regex work. */
function hasHarnessTag(text: string): boolean {
  return RE_ANY_TAG.test(text);
}

/** Last meaningful path segment, e.g. ".../skills/systematic-debugging" → that. */
function skillNameFromPath(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/**
 * Classify a `user`-role message that the user did NOT type. Returns the system
 * `kind` + a short human label, or null for a genuine user prompt.
 */
export function classifyInjection(text: string): { kind: SystemKind; label: string } | null {
  const skillBody = text.match(RE_SKILL_BODY);
  if (skillBody) return { kind: 'skill', label: skillNameFromPath(skillBody[1]) };

  const skillIntro = text.match(RE_SKILL_INTRO);
  if (skillIntro) return { kind: 'skill', label: skillIntro[1] };

  if (RE_SYSTEM_REMINDER.test(text)) return { kind: 'reminder', label: 'system reminder' };

  if (RE_HOOK_CONTEXT.test(text)) return { kind: 'hook', label: 'hook context' };

  return null;
}

/**
 * Rewrite raw harness/plumbing user entries into `command` and `system`
 * entries. All other entries pass through unchanged and order is preserved.
 */
export function transformEntries(entries: ConversationEntry[]): ConversationEntry[] {
  const out: ConversationEntry[] = [];

  for (const entry of entries) {
    if (entry.role !== 'user') {
      out.push(entry);
      continue;
    }

    const { text, timestamp } = entry;

    // Non-tagged injected content (skill body, system-reminder, hook context):
    // not typed by the user → demote to a labelled, collapsible system row.
    const injection = classifyInjection(text);
    if (injection) {
      out.push({ role: 'system', text: text.trim(), timestamp, kind: injection.kind, label: injection.label });
      continue;
    }

    // No harness tags and not injected → a genuine user prompt, untouched.
    if (!hasHarnessTag(text)) {
      out.push(entry);
      continue;
    }

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
      out.push({ role: 'system', text: stdout, timestamp, kind: 'plumbing' });
      continue;
    }

    // Caveat boilerplate (or any leftover plumbing) → collapsible system row.
    out.push({ role: 'system', text: caveat ?? text.trim(), timestamp, kind: 'plumbing' });
  }

  return out;
}
