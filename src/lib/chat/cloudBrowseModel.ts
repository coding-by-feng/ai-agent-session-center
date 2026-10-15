/**
 * cloudBrowseModel.ts — the words the phone's AASC Cloud screens and rows use
 * (AASC-51). Pure: no DOM, no fetch, `now` passed in.
 */
import type { CloudProject, CloudResource, CloudState, CloudStatus } from './cloudBrowseApi';

/** Where the cloud connection is made: only the Mac's desktop can do it. */
export const CLOUD_CONNECT_HINT = 'Connect this Mac to AASC Cloud on the desktop: RESOURCES → Cloud → Connection.';

/** After the Mac's cloud device was revoked: only the desktop can connect it again. */
export const CLOUD_RECONNECT_HINT = 'Connect it again on the desktop: RESOURCES → Cloud → Connection.';

/** What stays on the Mac, said once on the Cloud screen. */
export const CLOUD_READ_ONLY_NOTE = 'Read-only on this phone. Publishing, installing, restoring and project changes stay on your Mac.';

const STATE_WORDS: Record<CloudState, string> = {
  connected: 'Connected',
  unchecked: 'Connected',
  offline: 'Offline',
  revoked: 'Revoked',
  'not-connected': 'Not connected',
};

/** The connection in a word or two. The account itself is never shown: the Mac doesn't know a name for it. */
export function cloudStateWords(state: CloudState): string {
  return STATE_WORDS[state];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "just now", "5 min ago", "3 h ago", "2 days ago", then a date ("Oct 14", "Oct 14, 2025"). */
export function agoWords(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const age = Math.max(0, now - at);
  if (age < MIN) return 'just now';
  if (age < HOUR) return `${Math.floor(age / MIN)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  if (age < 7 * DAY) {
    const days = Math.floor(age / DAY);
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? '' : `, ${d.getFullYear()}`}`;
}

/** The status row's second line: when the Mac last read the cloud for this phone, or why it can't. */
export function syncWords(status: CloudStatus, now: number): string {
  if (status.state === 'not-connected') return 'Set it up on your Mac';
  if (status.lastSyncAt) return `Last synced ${agoWords(status.lastSyncAt, now)}`;
  if (status.state === 'unchecked') return 'Not checked since your Mac started';
  return 'Not synced yet';
}

/** A problem's first sentence: what a list row has room for (the Cloud screen shows it whole). */
export function firstSentence(text: string): string {
  const end = text.search(/[.!?](\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

/** A version's full date, in this phone's own time and language. */
export function versionDate(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const KIND_WORDS: Record<CloudResource['kind'], string> = {
  skill: 'Skill',
  command: 'Command',
  rule: 'Rule',
  agent: 'Agent',
  instruction: 'Instructions',
  memory: 'Memory',
};

const AGENT_WORDS: Record<CloudResource['agent'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  shared: 'Claude Code and Codex',
};

export const kindWords = (kind: CloudResource['kind']): string => KIND_WORDS[kind];
export const agentWords = (agent: CloudResource['agent']): string => AGENT_WORDS[agent];

/** "512 B", "2.4 KB", "1.2 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const filesWords = (n: number): string => (n === 1 ? '1 file' : `${n} files`);

/** A resource row's second line: "Skill · Claude Code · v3". */
export function resourceLine(r: CloudResource): string {
  return `${kindWords(r.kind)} · ${agentWords(r.agent)} · v${r.version}`;
}

export const resourcesWords = (n: number): string => (n === 1 ? '1 resource' : `${n} resources`);

/** A project's repository: "github.com/kason/website". */
export function repoWords(p: CloudProject): string {
  return `${p.host}/${p.owner}/${p.repo}`;
}

/** A project's default branch and what it pins: "Branch main · 4 resources". */
export function projectDetail(p: CloudProject): string {
  return `Branch ${p.branch} · ${resourcesWords(p.resources)}`;
}
