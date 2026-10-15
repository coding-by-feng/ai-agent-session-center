import type { CloudBinding } from './binding.js';
import type { DirectoryAnchor, DestinationSnapshot } from './installFs.js';
import type { ResourceDestination } from '../resourcePackages/adapters.js';
export interface InstallReceipt {
  id: string;
  resourceId: string;
  version: number;
  binding: CloudBinding;
  destination: ResourceDestination;
  anchors: DirectoryAnchor[];
  before: DestinationSnapshot | null;
  after: DestinationSnapshot;
  workspace: string;
  stage: string;
  backup: string;
  displaced: string;
  state: 'prepared' | 'backed-up' | 'installed' | 'restoring' | 'restored' | 'attention';
}
export interface PublicInstallReceipt {
  id: string;
  resourceId: string;
  version: number;
  state: InstallReceipt['state'];
  canRestore: boolean;
}
export function publicReceipt(r: InstallReceipt): PublicInstallReceipt {
  return {
    id: r.id,
    resourceId: r.resourceId,
    version: r.version,
    state: r.state,
    canRestore: !!r.before && r.state === 'installed',
  };
}
