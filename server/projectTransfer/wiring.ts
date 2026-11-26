/**
 * The project-transfer router with this server's real parts (docs/plans/project-transfer.md):
 * paired computers from the device store, Tailscale/HTTPS from the socket, the Allow list and the
 * moved markers in the data folder, and the pending Allows sent to this computer's own windows only.
 */
import type { Request, Router } from 'express';
import type { Session } from '../../src/types/session.js';
import type { IncomingTransferRequest } from '../../src/types/projectTransfer.js';
import { bearerSession } from '../authManager.js';
import { workingProjectPaths } from '../cloud/agentWork.js';
import { getHostedConfig } from '../hostedConfig.js';
import { sqliteMobileDeviceStore } from '../mobile/deviceStore.js';
import { isTailnetAddress } from '../networkInfo.js';
import { isLocalRequest } from '../requestLocality.js';
import { exportAascBundle, importAascBundle } from './aascBundle.js';
import { createAllowList, createMovedLog, transferDataDir } from './records.js';
import { createReceiver } from './receiver.js';
import { createProjectTransferRouter } from './router.js';
import { createSender } from './sender.js';

export const PROJECT_TRANSFER_REQUESTS = 'project_transfer_requests';

export interface ProjectTransferWiring {
  sessions(): Session[];
  /** Send to this computer's own windows only (wsManager.broadcastByLocality with no remote side). */
  broadcastLocal(message: { type: string; requests: IncomingTransferRequest[] }): void;
}

/** The peer address without an IPv4-mapped prefix. */
function peerOf(req: Request): string {
  const raw = req.socket?.remoteAddress ?? '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/** A paired computer's active session, by its Bearer token only (never a cookie). */
function computerOf(req: Request): { id: string; label: string } | null {
  const session = bearerSession(req);
  if (!session?.computerId) return null;
  const record = sqliteMobileDeviceStore.get(session.computerId);
  if (!record || record.status !== 'active' || record.platform !== 'desktop') return null;
  return { id: record.id, label: record.label };
}

/** Tailscale (WireGuard) or a hosted server's HTTPS front: never plain HTTP over a LAN or the Internet. */
function secureChannel(req: Request): boolean {
  return isTailnetAddress(peerOf(req)) || getHostedConfig() !== null;
}

export function createProjectTransferWiring(wiring: ProjectTransferWiring): Router {
  const dir = transferDataDir();
  const allowList = createAllowList(dir);
  const receiver = createReceiver({
    isAllowed: (id) => allowList.isAllowed(id),
    allow: (id, label) => allowList.allow(id, label),
    onRequestsChanged: (requests) => wiring.broadcastLocal({ type: PROJECT_TRANSFER_REQUESTS, requests }),
    importAasc: (raw, opts) => importAascBundle(raw, opts),
  });
  const sender = createSender({
    workingPaths: () => workingProjectPaths(wiring.sessions()),
    exportAasc: (root) => exportAascBundle(root),
  });
  return createProjectTransferRouter({
    allowed: allowList,
    sender,
    receiver,
    moved: createMovedLog(dir),
    isLocal: (req) => isLocalRequest(req),
    computerOf,
    secureChannel,
  });
}
