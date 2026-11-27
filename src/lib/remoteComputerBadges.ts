/**
 * remoteComputerBadges — the devices switcher's row badges (Nov 27 2026): a computer's state, how it was reached and
 * its session counts as pills on the row's second line, where one long "Online · Tailscale · 4 shared · 1 needs you"
 * line used to sit. A reason no pill can say (why it is offline, the Allow code) follows as words.
 *
 * Pure, and drawn from the same 30 s check as the sentence (`rowDetail` / `accountRowDetail`), which stays the row's
 * accessible text: the pills are a look, not new data.
 */
import { formatConfirmCode } from '@/lib/mobilePairingApi';
import { rowState } from '@/lib/remoteComputerRows';
import type { RemoteComputer, RemoteComputerCheck } from '@/types/electron';

/** One look per meaning: green online, grey offline, amber waiting or worth a look, red removed. */
export type BadgeTone = 'online' | 'offline' | 'pending' | 'removed' | 'checking' | 'neutral' | 'warn';

export interface RowBadge {
  /** Stable within a row, for React keys. */
  id: 'state' | 'via' | 'shared' | 'needs' | 'sessions';
  tone: BadgeTone;
  label: string;
}

export interface RowBadges {
  badges: RowBadge[];
  /** Words after the pills; null when the pills say it all. */
  reason: string | null;
}

export interface RowBadgeOptions {
  /** A computer on the account: removed reads grey, since Connect can bring it back. */
  account?: boolean;
  /** Connect is running for it. */
  connecting?: boolean;
  /** The check itself was refused: its reason shows as the row's alert, not here. */
  checkFailed?: boolean;
}

const VIA: Record<NonNullable<RemoteComputerCheck['via']>, { label: string; tone: BadgeTone }> = {
  lan: { label: 'Home network', tone: 'neutral' },
  tailnet: { label: 'Tailscale', tone: 'neutral' },
  https: { label: 'Secure HTTPS', tone: 'neutral' },
  public: { label: 'Public IP, unencrypted', tone: 'warn' },
};

function needsBadge(count: number | null | undefined): RowBadge[] {
  if (count == null || count <= 0) return [];
  return [{ id: 'needs', tone: 'warn', label: `${count} ${count === 1 ? 'needs' : 'need'} you` }];
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function rowBadges(c: RemoteComputer, check: RemoteComputerCheck | undefined, opts: RowBadgeOptions = {}): RowBadges {
  if (opts.connecting) return { badges: [{ id: 'state', tone: 'checking', label: 'Connecting…' }], reason: null };
  const state = rowState(c, check);
  if (state === 'online') {
    const via = check?.via ? [{ id: 'via' as const, ...VIA[check.via] }] : [];
    const shared: RowBadge[] = check?.sharedSessions != null
      ? [{ id: 'shared', tone: 'neutral', label: `${check.sharedSessions} shared` }]
      : [];
    return { badges: [{ id: 'state', tone: 'online', label: 'Online' }, ...via, ...shared, ...needsBadge(check?.needsYou)], reason: null };
  }
  if (state === 'pending') {
    return {
      badges: [{ id: 'state', tone: 'pending', label: 'Waiting for Allow' }],
      reason: c.confirmCode ? `Code ${formatConfirmCode(c.confirmCode)}` : null,
    };
  }
  if (state === 'revoked') {
    return { badges: [{ id: 'state', tone: opts.account ? 'offline' : 'removed', label: 'Removed on that computer' }], reason: null };
  }
  if (state === 'offline') {
    const reason = check?.message && !opts.checkFailed ? sentenceCase(check.message) : null;
    return { badges: [{ id: 'state', tone: 'offline', label: 'Offline' }], reason };
  }
  return { badges: [{ id: 'state', tone: 'checking', label: 'Checking…' }], reason: null };
}

/** This computer's pills: its sessions and how many need the person; none with no sessions. */
export function sessionBadges(sessions: number, needsYou: number): RowBadge[] {
  if (sessions <= 0) return [];
  return [{ id: 'sessions', tone: 'neutral', label: `${sessions} ${sessions === 1 ? 'session' : 'sessions'}` }, ...needsBadge(needsYou)];
}
