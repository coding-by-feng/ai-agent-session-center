/**
 * The sentences the Copy / Move dialog shows (Nov 27 2026, docs/plans/project-transfer.md). Pure, so
 * the wording is tested once and the dialog only lays it out.
 */
import type {
  TransferMode,
  TransferOptions,
  TransferOutcome,
  TransferPlanSummary,
  TransferProgress,
} from '@/types/projectTransfer';
import type { RemoteComputer } from '@/types/electron';
import { formatBytes } from '@/lib/diskUsage';

export { formatBytes };

/** 1842 → "1,842". */
export const count = (n: number) => n.toLocaleString('en-US');

const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** A computer can take a project only over Tailscale or HTTPS: a LAN or public address is plain HTTP. */
export const reachesSecurely = (c: RemoteComputer) => !!(c.tailnet || c.httpsOrigin);

/** `~/Documents/app` — the folder must sit inside the computer's home. Null when it reads well. */
export function destinationProblem(destination: string): string | null {
  const d = destination.trim();
  if (!d.startsWith('~/') || d.length < 3) return 'Start the folder with ~/';
  if (d.split('/').some((part) => part === '..')) return 'The folder can’t contain “..”';
  return null;
}

/** One line per group the transfer brings, in the order the dialog lists them. */
export function summaryLines(summary: TransferPlanSummary, options: TransferOptions): string[] {
  const project = summary.byGroup.project;
  const lines = [`Project: ${plural(project.files, 'file')} · ${formatBytes(project.bytes)}`];
  if (options.memory) {
    const files = summary.byGroup.claude.files + summary.byGroup.codex.files;
    const bytes = summary.byGroup.claude.bytes + summary.byGroup.codex.bytes;
    lines.push(
      files > 0
        ? `Agent memory: ${plural(files, 'file')} · ${formatBytes(bytes)}`
        : 'Agent memory: none for this folder',
    );
  }
  if (options.aasc) {
    const a = summary.aasc;
    const parts = a
      ? [
          a.sessions && plural(a.sessions, 'session'),
          a.prompts && plural(a.prompts, 'prompt'),
          a.notes && plural(a.notes, 'note'),
          a.queues && plural(a.queues, 'queue'),
        ].filter(Boolean)
      : [];
    lines.push(
      parts.length ? `AASC history: ${parts.join(', ')}` : 'AASC history: none for this folder',
    );
  }
  if (summary.skippedCount > 0) lines.push(`Left out: ${plural(summary.skippedCount, 'item')}`);
  return lines;
}

/** The running line under the progress bar. */
export function progressLine(p: TransferProgress, computer: string): string {
  switch (p.stage) {
    case 'connecting':
      return `Connecting to ${computer}…`;
    case 'waiting-allow':
      return `Waiting for Allow on ${computer}…`;
    case 'sending':
      return `Sending ${count(p.sentFiles)} of ${count(p.totalFiles)} files · ${formatBytes(p.sentBytes)} of ${formatBytes(p.totalBytes)}`;
    case 'committing':
      return 'Putting it in place…';
    case 'moving':
      return 'Moving this folder to the Trash…';
    case 'done':
      return 'Finishing…';
    case 'failed':
      return p.message ?? 'Stopping…';
  }
}

/** 0–1 for the bar: bytes while sending, full once the files are there. */
export function progressFraction(p: TransferProgress | null): number {
  if (!p) return 0;
  if (p.stage === 'committing' || p.stage === 'moving' || p.stage === 'done') return 1;
  if (p.stage !== 'sending' || p.totalBytes <= 0) return 0;
  return Math.min(1, p.sentBytes / p.totalBytes);
}

/** "Copied to studio at ~/code/app · 1,842 files · memory and history". */
export function doneLine(
  outcome: TransferOutcome,
  computer: string,
  mode: TransferMode,
  options: TransferOptions,
): string {
  const c = outcome.commit;
  const extras = [options.memory && 'memory', options.aasc && 'history']
    .filter(Boolean)
    .join(' and ');
  const line = `${mode === 'move' ? 'Moved' : 'Copied'} to ${computer} at ${c.destination} · ${plural(c.files, 'file')}${extras ? ` · ${extras}` : ''}`;
  if (mode !== 'move') return line;
  if (outcome.moved) return `${line}. ${outcome.moveMessage ?? 'This folder is in the Trash.'}`;
  return `${line}. ${outcome.moveMessage ?? 'This folder stayed here.'}`;
}

/** "Moved to studio · Nov 27". */
export function movedLine(computer: string, at: number): string {
  const date = new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `Moved to ${computer} · ${date}`;
}
