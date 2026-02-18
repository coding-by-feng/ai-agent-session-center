/**
 * CLI detection utility.
 * Determines which AI CLI (Claude, Gemini, Codex, OpenClaw) a session belongs to
 * based on the model name and event types.
 *
 * Shared by SessionRobot (badge rendering) and AlarmEngine (per-CLI sound profiles).
 */
import type { Session } from '@/types';

/** Supported CLI identifiers matching SoundSettings.perCli keys */
export type CliName = 'claude' | 'gemini' | 'codex' | 'openclaw';

/**
 * Detect which CLI a session belongs to.
 * 1. Check session.model for CLI-specific keywords
 * 2. Fallback: check event types for CLI-specific events
 * Returns null if the CLI cannot be determined.
 */
export function detectCli(session: Session): CliName | null {
  const model = (session.model || '').toLowerCase();

  // Model-based detection (most reliable)
  if (model.includes('claude') || model.includes('opus') || model.includes('sonnet') || model.includes('haiku')) {
    return 'claude';
  }
  if (model.includes('gemini') || model.includes('gemma')) {
    return 'gemini';
  }
  if (model.includes('gpt') || model.includes('codex') || model.includes('o1') || model.includes('o3') || model.includes('o4')) {
    return 'codex';
  }
  if (model.includes('openclaw') || model.includes('claw')) {
    return 'openclaw';
  }

  // Event-type fallback
  const events = session.events || [];

  const hasGeminiEvent = events.some(e =>
    e.type === 'BeforeAgent' || e.type === 'AfterAgent' ||
    e.type === 'BeforeTool' || e.type === 'AfterTool'
  );
  if (hasGeminiEvent) return 'gemini';

  const hasCodexEvent = events.some(e => e.type === 'agent-turn-complete');
  if (hasCodexEvent) return 'codex';

  const hasClaudeEvent = events.some(e =>
    e.type === 'SessionStart' || e.type === 'PreToolUse' ||
    e.type === 'PostToolUse' || e.type === 'UserPromptSubmit'
  );
  if (hasClaudeEvent) return 'claude';

  return null;
}
