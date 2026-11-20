/**
 * remoteComputerRows — what a row of another AASC computer says, and which rows the devices switcher draws.
 *
 * Pure. Two kinds of row share it: a computer paired by link (`RemoteComputers`, the switcher's "Paired by link")
 * and a computer on this computer's AASC Cloud account (the switcher's "My computers", plan 18 stage 2).
 *
 * A record made through the account is never a "paired by link" row, and the other way round: `origin` decides,
 * and a record from before plan 18 (no `origin`) reads as link.
 */
import { formatConfirmCode } from '@/lib/mobilePairingApi';
import type { AccountMachine, RemoteComputer, RemoteComputerCheck } from '@/types/electron';

export type RowState = RemoteComputerCheck['state'] | 'checking';

/** One row under "My computers". */
export interface AccountRow {
  /**
   * One computer, one key, whatever the directory says: the machine's device id, taken from the directory or from the
   * record (`backendDeviceId`). It is the row's React key: a key that changed when the directory landed remounted the
   * row on every opening of the panel, closing its ⋯ menu and losing a rename being typed.
   */
  key: string;
  name: string;
  /** What `accountConnect` takes; null when nothing names the machine. */
  machineId: string | null;
  /** This computer's record for the machine; null until it connects. */
  record: RemoteComputer | null;
  /** False: the machine signed in before it could take a connection through the account, and must sign in again there. */
  connectable: boolean;
}

/**
 * The live check wins; before the first one, the stored status says what it can. Removed is the exception: a removed
 * row is never checked again, so its last check is out of date for good.
 */
export function rowState(c: RemoteComputer, check: RemoteComputerCheck | undefined): RowState {
  if (c.status === 'revoked') return 'revoked';
  if (check) return check.state;
  return c.status === 'pending' ? 'pending' : 'checking';
}

/**
 * "1 needs you", "3 need you": sessions waiting for an approval or an answer. Null for none, so nothing ever reads
 * "0 need you". No-break spaces inside: in the narrow panel a line wraps at a " · " seam, never inside the phrase.
 */
function needWords(count: number | null | undefined): string | null {
  if (count == null || count <= 0) return null;
  return `${count} ${count === 1 ? 'needs' : 'need'} you`.replace(/ /g, '\u00a0');
}

/** State · path · counts, in that order. */
function onlineWords(check: RemoteComputerCheck | undefined): string {
  const via = check?.via === 'tailnet' ? 'Tailscale' : check?.via === 'lan' ? 'Home network'
    : check?.via === 'https' ? 'Secure HTTPS' : check?.via === 'public' ? 'Public IP, unencrypted' : null;
  const shared = check?.sharedSessions != null ? `${check.sharedSessions} shared` : null;
  return ['Online', via, shared, needWords(check?.needsYou)].filter(Boolean).join(' · ');
}

/**
 * This computer's own second line in the switcher: its sessions, and how many of them need the person. Null with
 * no sessions: the row then has no second line.
 */
export function sessionsLine(sessions: number, needsYou: number): string | null {
  if (sessions <= 0) return null;
  return [`${sessions} ${sessions === 1 ? 'session' : 'sessions'}`, needWords(needsYou)].filter(Boolean).join(' · ');
}

/** The switcher offers its search field over this many computer rows (account and link; this computer is not one). */
const SEARCH_OVER = 7;

export function searchShown(computerRows: number): boolean {
  return computerRows > SEARCH_OVER;
}

/** The search's one rule: the text, without the spaces at its ends, is somewhere in the name shown, in any case. */
export function matchesName(name: string, text: string): boolean {
  return name.toLowerCase().includes(text.trim().toLowerCase());
}

/** The second line of a computer paired by link. It always names the state, so the dot's colour is never the only sign. */
export function rowDetail(c: RemoteComputer, check: RemoteComputerCheck | undefined): string {
  const state = rowState(c, check);
  if (state === 'online') return onlineWords(check);
  if (state === 'pending') {
    return c.confirmCode ? `Waiting for Allow · code ${formatConfirmCode(c.confirmCode)}` : 'Waiting for Allow';
  }
  if (state === 'offline') return check?.message ? `Offline: ${check.message}` : 'Offline';
  if (state === 'revoked') return 'Removed on that computer';
  return 'Checking…';
}

/**
 * The second line of an account computer that has a record. `checkFailed`: the check itself was refused, and its
 * reason shows as the alert under the row instead of here. Removed on that computer reads as it does for a computer
 * paired by link; the row then offers Connect (`needsConnect`).
 */
export function accountRowDetail(c: RemoteComputer, check: RemoteComputerCheck | undefined, checkFailed: boolean): string {
  const state = rowState(c, check);
  if (state === 'online') return onlineWords(check);
  if (state === 'pending') {
    // No-break spaces inside "code 482 913": in the narrow panel the line wraps at the " · " seam, never inside the code.
    const code = c.confirmCode ? ` · ${`code ${formatConfirmCode(c.confirmCode)}`.replace(/ /g, '\u00a0')}` : '';
    return `Waiting for Allow on ${c.name}${code}`;
  }
  if (state === 'checking') return 'Checking…';
  if (state === 'revoked') return 'Removed on that computer';
  return check?.message && !checkFailed ? `Offline: ${check.message}` : 'Offline';
}

/**
 * Whether an account computer's row offers Connect in Open's place: Open could never work, and `accountConnect`
 * enrolls again into the same row. True when the machine removed this computer, which shows either as `revoked` or,
 * for an active record, as a check marked `unproved` (something answered at its address and no proof verified).
 * Plain offline (nothing answered) keeps Open, which retries. Never true for a computer paired by link.
 */
export function needsConnect(c: RemoteComputer, check: RemoteComputerCheck | undefined): boolean {
  if (!isAccountRecord(c)) return false;
  const state = rowState(c, check);
  return state === 'revoked' || (state === 'offline' && check?.unproved === true);
}

function isAccountRecord(c: RemoteComputer): boolean {
  return c.origin === 'account';
}

/** The records for "Paired by link". */
export function linkRecords(computers: readonly RemoteComputer[] | null): RemoteComputer[] {
  return (computers ?? []).filter((c) => !isAccountRecord(c));
}

/**
 * The rows of "My computers": the account's other computers, each with this computer's record for it, then any
 * account record whose machine the directory does not list (or every account record when there is no directory to
 * read: signed out, or AASC Cloud unreachable), so a computer already connected stays usable.
 *
 * The record comes from the list once it is read: it is re-read after every check, while the directory's copy can be
 * a minute old.
 */
export function accountRows(machines: readonly AccountMachine[] | null, computers: readonly RemoteComputer[] | null): AccountRow[] {
  const records = (computers ?? []).filter(isAccountRecord);
  const listed = (machines ?? []).filter((m) => !m.current && m.relation === 'self');
  const rows: AccountRow[] = listed.map((m) => {
    const record = computers === null ? m.record : records.find((c) => c.backendDeviceId === m.deviceId) ?? null;
    return { key: m.deviceId, name: record?.name ?? m.name, machineId: m.deviceId, record, connectable: m.connectable };
  });
  const shown = new Set(rows.map((row) => row.record?.id));
  const taken = new Set(rows.map((row) => row.key));
  const unlisted: AccountRow[] = [];
  for (const c of records) {
    if (shown.has(c.id)) continue;
    // The machine's id, as a listed row would have: only a second record for one machine falls back to its own id.
    const key = c.backendDeviceId !== undefined && !taken.has(c.backendDeviceId) ? c.backendDeviceId : c.id;
    taken.add(key);
    unlisted.push({ key, name: c.name, machineId: c.backendDeviceId ?? null, record: c, connectable: true });
  }
  return [...rows, ...unlisted];
}

/** How many rows are online by their latest check, for "2 of 3 online". */
export function countOnline(rows: readonly AccountRow[], checks: Readonly<Record<string, RemoteComputerCheck>>): number {
  return rows.filter((row) => row.record !== null && rowState(row.record, checks[row.record.id]) === 'online').length;
}

/** The list with a record `accountConnect` just answered: in the place of that machine's old record, or at the end. */
export function withRecord(list: readonly RemoteComputer[] | null, record: RemoteComputer): RemoteComputer[] {
  const replaces = (c: RemoteComputer) => c.id === record.id
    || (isAccountRecord(record) && isAccountRecord(c) && c.backendDeviceId !== undefined && c.backendDeviceId === record.backendDeviceId);
  const current = list ?? [];
  const at = current.findIndex(replaces);
  if (at < 0) return [...current, record];
  return [...current.slice(0, at), record, ...current.slice(at + 1).filter((c) => !replaces(c))];
}
