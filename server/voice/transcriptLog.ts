// transcriptLog.ts — a voice call's transcript, rebuilt from GPT-Live's transcript deltas.
//
// GPT-Live sends `session.input_transcript.delta` (the person) and `session.output_transcript.delta` (the voice) as
// fragments with `start_ms`/`end_ms` and no turn id, and a client delegation carries no text of its own. So the call
// keeps its own lines: deltas of one speaker join one line until the other speaker talks or a pause of PAUSE_MS.

export type Speaker = 'user' | 'assistant';

export interface TranscriptLine {
  role: Speaker;
  text: string;
  startMs: number;
  endMs: number;
}

/** A pause this long starts a new line even when the same speaker goes on. */
export const PAUSE_MS = 2_500;

export interface TranscriptLog {
  add(role: Speaker, delta: string, startMs: number, endMs: number): void;
  /** What the person said in lines that end after `offsetMs`; their last line when none does. */
  userSince(offsetMs: number): string;
  /** The newest lines that fit in `maxChars`, oldest first, as "Person: … / AASC: …". */
  recent(maxChars: number): string;
  lines(): readonly TranscriptLine[];
}

const LABEL: Record<Speaker, string> = { user: 'Person', assistant: 'AASC' };

export function createTranscriptLog(maxLines = 200): TranscriptLog {
  let lines: TranscriptLine[] = [];

  return {
    add(role, delta, startMs, endMs) {
      if (!delta) return;
      const last = lines[lines.length - 1];
      if (last && last.role === role && startMs - last.endMs < PAUSE_MS) {
        lines = [...lines.slice(0, -1), { ...last, text: last.text + delta, endMs: Math.max(last.endMs, endMs) }];
      } else {
        lines = [...lines, { role, text: delta, startMs, endMs }].slice(-maxLines);
      }
    },

    userSince(offsetMs) {
      const mine = lines.filter((l) => l.role === 'user');
      const newer = mine.filter((l) => l.endMs > offsetMs);
      const chosen = newer.length > 0 ? newer : mine.slice(-1);
      return chosen.map((l) => l.text.trim()).filter(Boolean).join(' ');
    },

    recent(maxChars) {
      const picked: string[] = [];
      let used = 0;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const entry = `${LABEL[lines[i].role]}: ${lines[i].text.trim()}`;
        if (used + entry.length + 3 > maxChars) break;
        picked.unshift(entry);
        used += entry.length + 3;
      }
      return picked.join(' / ');
    },

    lines: () => lines,
  };
}
