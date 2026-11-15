// digest.ts — the AASC status a voice call knows without asking: which sessions need the person, which are working,
// which finished recently. Sent to the voice as silent context (`session.thinking.append`, at most 500 tokens), so
// "is anything waiting?" is answered at once instead of costing a Voice-central turn.
//
// The caller passes only the sessions the calling device may see (sessionVisibility.ts): a phone hears only shared
// sessions, the same rule as every other remote read.

/** What the digest reads of a session. */
export interface DigestSession {
  sessionId: string;
  title: string;
  status: string;
  lastActivityAt: number;
  /** Central sessions (the Voice central among them) are left out: they are the backend, not the work. */
  isCentral: boolean;
}

/** The longest digest (a `session.thinking.append` holds at most 500 tokens). */
export const DIGEST_MAX = 1_500;

/** A session that stopped this recently counts as "finished recently"; older ones are idle. */
export const RECENT_MS = 30 * 60_000;

const TITLE_MAX = 40;
const BUSY = new Set(['working', 'prompting']);
const NEEDS_USER = new Set(['approval', 'input']);

const short = (title: string): string => (title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1)}…`);
const minutes = (ms: number): number => Math.max(0, Math.round(ms / 60_000));

/** Up to `room` characters of items, then "and N more". */
function listWithin(items: readonly string[], room: number): string {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.length - i - 1;
    const tail = rest > 0 ? ` and ${rest} more` : '';
    if (used + items[i].length + 2 + tail.length > room && out.length > 0) {
      return `${out.join(', ')} and ${items.length - i} more`;
    }
    out.push(items[i]);
    used += items[i].length + 2;
  }
  return out.join(', ');
}

export function buildDigest(sessions: readonly DigestSession[], now: number): string {
  const open = sessions.filter((s) => s.status !== 'ended' && !s.isCentral);
  if (open.length === 0) return 'AASC status: no sessions are open.';

  const needs = open.filter((s) => NEEDS_USER.has(s.status));
  const working = open.filter((s) => BUSY.has(s.status) || s.status === 'connecting');
  const finished = open
    .filter((s) => s.status === 'waiting' && now - s.lastActivityAt <= RECENT_MS)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const idle = open.length - needs.length - working.length - finished.length;

  const head = `AASC status: ${open.length} session${open.length === 1 ? '' : 's'}.`;
  const sections: Array<[string, string[]]> = [
    ['Needs the user', needs.map((s) => `"${short(s.title)}" (${s.status === 'approval' ? 'approval' : 'question'})`)],
    ['Working', working.map((s) => `"${short(s.title)}" (${s.status === 'connecting' ? 'starting' : `${minutes(now - s.lastActivityAt)} min`})`)],
    ['Finished recently', finished.map((s) => `"${short(s.title)}" (${minutes(now - s.lastActivityAt)} min ago)`)],
  ];
  const tail = idle > 0 ? ` Idle: ${idle}.` : '';
  let text = head;
  const filled = sections.filter(([, items]) => items.length > 0);
  filled.forEach(([label, items], i) => {
    const sectionsLeft = filled.length - i;
    const room = Math.floor((DIGEST_MAX - text.length - tail.length) / sectionsLeft) - label.length - 4;
    text += ` ${label}: ${listWithin(items, Math.max(room, 20))}.`;
  });
  return (text + tail).slice(0, DIGEST_MAX);
}

export interface StatusChanges {
  /** Titles of sessions that went from working to finished. */
  finished: string[];
  /** Titles of sessions that now wait on an approval or a question. */
  needsUser: string[];
}

/** What changed since `prev` (session id → status) worth saying aloud. Sessions not in `prev` are skipped. */
export function statusChanges(prev: ReadonlyMap<string, string>, next: readonly DigestSession[]): StatusChanges {
  const finished: string[] = [];
  const needsUser: string[] = [];
  for (const s of next) {
    if (s.isCentral) continue;
    const before = prev.get(s.sessionId);
    if (before === undefined || before === s.status) continue;
    if (NEEDS_USER.has(s.status) && !NEEDS_USER.has(before)) needsUser.push(s.title);
    else if (s.status === 'waiting' && BUSY.has(before)) finished.push(s.title);
  }
  return { finished, needsUser };
}
