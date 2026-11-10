import { join } from 'node:path';
import type { Request } from 'express';
import type { HostedConfig } from './hostedConfig.js';
import { getTokenHostedIdentity, extractToken } from './authManager.js';
import { currentHostedOwner } from './hostedAuthority.js';
import { hostedSessionAllowed } from './hostedAccess.js';
import { createWorkspaceContinuationRouter } from './workspaceContinuation.js';

/** Mounted after authMiddleware; edition never participates in owner scope. */
export function createHostedContinuationRouter(
  config: HostedConfig,
  visible: (req: Request, id: string) => boolean,
) {
  return createWorkspaceContinuationRouter({
    directory: join(config.dataDir, 'workspace-continuation'),
    scope: (req) => {
      const identity = getTokenHostedIdentity(extractToken(req));
      const owner = currentHostedOwner(config);
      return identity &&
        owner &&
        identity.sub === owner.sub &&
        identity.ownerEpoch === owner.ownerEpoch &&
        identity.accessMode === owner.accessMode &&
        hostedSessionAllowed(config, req)
        ? JSON.stringify([config.orderId, identity.sub, identity.ownerEpoch])
        : null;
    },
    visible,
  });
}
