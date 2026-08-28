/**
 * presenceStore — which devices are connected, and which one drives each session.
 *
 * The server is the single source of truth (`server/presenceManager.ts`); this
 * store is a read-model fed by the `presence_update` WebSocket message, plus a
 * little local UI state (pending hand-over requests, the last denial notice).
 *
 * ## The model in one line
 *
 * Reads are shared, writes are exclusive: every device sees every session and
 * every terminal live, but only the device holding a session's baton may type
 * into it, send its queue, kill it, or resize it. That is not a limitation
 * being worked around — two people typing into one PTY interleaves their
 * keystrokes into garbage, and two queue schedulers ticking on one session fire
 * every prompt twice.
 *
 * `canControl` is deliberately permissive in two directions, and both matter:
 * an unclaimed session is writable by anyone (a brand-new session must be
 * usable before anything claims it), and a session whose holder has
 * disconnected is writable by anyone (closing the laptop hands its sessions to
 * the phone with no timer and no cleanup pass).
 */
import { create } from 'zustand';
import { getClientId } from '@/lib/deviceIdentity';
import type { ControlHolderView, DevicePresence } from '@/types';

/** A hand-over request this device has received, keyed by session. */
export interface PendingControlRequest {
  sessionId: string;
  fromClientId: string;
  fromLabel: string;
  at: number;
}

/** The most recent "you don't control this" notice, for UI feedback. */
export interface ControlDenial {
  sessionId: string;
  by: string | null;
  at: number;
}

interface PresenceState {
  devices: DevicePresence[];
  /** sessionId -> holder */
  controllers: Map<string, ControlHolderView>;
  restoreOwner: string | null;
  workspaceWriter: string | null;
  /** sessionId -> incoming hand-over request aimed at THIS device. */
  pendingRequests: Map<string, PendingControlRequest>;
  lastDenial: ControlDenial | null;

  applyPresence: (update: {
    devices: DevicePresence[];
    controllers: ControlHolderView[];
    restoreOwner: string | null;
    workspaceWriter: string | null;
  }) => void;
  addRequest: (req: PendingControlRequest) => void;
  clearRequest: (sessionId: string) => void;
  setDenial: (denial: ControlDenial | null) => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  devices: [],
  controllers: new Map(),
  restoreOwner: null,
  workspaceWriter: null,
  pendingRequests: new Map(),
  lastDenial: null,

  applyPresence: (update) =>
    set(() => ({
      devices: update.devices,
      controllers: new Map(update.controllers.map((c) => [c.sessionId, c])),
      restoreOwner: update.restoreOwner,
      workspaceWriter: update.workspaceWriter,
    })),

  addRequest: (req) =>
    set((s) => {
      const next = new Map(s.pendingRequests);
      next.set(req.sessionId, req);
      return { pendingRequests: next };
    }),

  clearRequest: (sessionId) =>
    set((s) => {
      if (!s.pendingRequests.has(sessionId)) return s;
      const next = new Map(s.pendingRequests);
      next.delete(sessionId);
      return { pendingRequests: next };
    }),

  setDenial: (lastDenial) => set(() => ({ lastDenial })),
}));

// ---------------------------------------------------------------------------
// Selectors — pure helpers usable outside React (schedulers, watchdogs)
// ---------------------------------------------------------------------------

/**
 * May this device write to `sessionId`?
 *
 * Free when unclaimed, ours, or held by a device that has gone offline. Mirrors
 * `presenceManager.canControl` exactly — the server still enforces it, so a
 * disagreement costs a rejected write, never a lost keystroke.
 */
export function canControlSession(sessionId: string): boolean {
  const holder = usePresenceStore.getState().controllers.get(sessionId);
  if (!holder) return true;
  if (holder.clientId === getClientId()) return true;
  return !holder.online;
}

/** The device holding `sessionId`, or null when it is free. */
export function controllerOf(sessionId: string): ControlHolderView | null {
  const holder = usePresenceStore.getState().controllers.get(sessionId);
  if (!holder || !holder.online) return null;
  return holder;
}

/** True when another ONLINE device holds this session — i.e. we are a spectator. */
export function isSpectator(sessionId: string): boolean {
  const holder = controllerOf(sessionId);
  return !!holder && holder.clientId !== getClientId();
}

/**
 * May this device persist the shared workspace snapshot?
 *
 * Only one may: the snapshot carries the ROOM LAYOUT, which lives in each
 * client's own localStorage, so a phone that has never seen the desktop's rooms
 * would overwrite them with an empty set. Unknown (no presence yet) reads as
 * true so a solo client is never blocked from saving.
 */
export function canWriteWorkspace(): boolean {
  const writer = usePresenceStore.getState().workspaceWriter;
  return writer === null || writer === getClientId();
}

/** Devices other than this one. */
export function otherDevices(): DevicePresence[] {
  const me = getClientId();
  return usePresenceStore.getState().devices.filter((d) => d.clientId !== me);
}

/** How many sessions this device currently drives. */
export function controlledCount(clientId: string): number {
  let n = 0;
  for (const holder of usePresenceStore.getState().controllers.values()) {
    if (holder.clientId === clientId && holder.online) n++;
  }
  return n;
}
