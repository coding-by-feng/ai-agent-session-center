// skillNoteOpsWiring.ts — how server/index.ts mounts the window op routes (skillNoteOpsRouter.ts): a central's
// skill-note change and keep-awake switch, both carried out by the workspace writer's window.
//
// The writer must be a window on this Mac (D-M1). The workspace writer prefers a local device, so a remote one is the
// writer only when no window on this Mac is open: that remote browser could apply the change but never answer it (its
// result is refused as not local), and the central would be told "pending" every time. With no local writer the route
// answers 409, which the tools turn into NO_WINDOW. A paired phone is never the writer, even on loopback.

import type { Router } from 'express';
import type { DevicePresence } from './presenceManager.js';
import { createSkillNoteOpsRouter, type SkillNoteOpsDeps } from './skillNoteOpsRouter.js';

/** The slice of presenceManager the wiring reads. */
export interface WiringPresence {
  getWorkspaceWriter(): string | null;
  getDevice(clientId: string): DevicePresence | null;
}

export interface SkillNoteOpsWiringDeps extends Omit<SkillNoteOpsDeps, 'writer'> {
  /** Is this device a paired phone? `isPairedPhoneClient` from wsManager. */
  isPhone: (clientId: string) => boolean;
}

/** The workspace writer when it is a window on this Mac and not a phone; null otherwise. */
export function localWriter(presence: WiringPresence, isPhone: (clientId: string) => boolean): string | null {
  const writer = presence.getWorkspaceWriter();
  if (!writer || isPhone(writer)) return null;
  return presence.getDevice(writer)?.isLocal === true ? writer : null;
}

export function createSkillNoteOpsWiring(presence: WiringPresence, deps: SkillNoteOpsWiringDeps): Router {
  const { isPhone, ...routerDeps } = deps;
  return createSkillNoteOpsRouter({ ...routerDeps, writer: () => localWriter(presence, isPhone) });
}
