/**
 * phoneResources — what the phone's More → Resources reads (Oct 24 2026, plan 16): the desktop
 * RESOURCES tab's Library, Cloud sync and Projects, through the Mac (`server/mobile/phoneResources.ts`).
 *
 * Shared by the server and the phone. Every path is a display path (`~/…`); config values arrive
 * masked by the catalog, as on the desktop. A resource filed under a project reaches a phone only
 * when that project has a session shared with it.
 */
import type { ResourceDetail, ResourceFileContent, ResourceProject, ResourceSummary, ResourceUsage, ScanState } from './resources.js';
import type { SyncItem } from './cloudResources.js';
import type { CheckoutState, GithubAccounts } from './cloudProjects.js';

/** Whose sessions a use count covers: every session (the Mac itself) or those shared with the phone. */
export type PhoneUsageScope = 'all' | 'shared';

export interface PhoneLibrary {
  state: ScanState;
  scannedAt: number | null;
  resources: ResourceSummary[];
  /** The projects the listed resources belong to: name and display path. */
  projects: Pick<ResourceProject, 'id' | 'name' | 'path'>[];
  /** Null while unknown (no scan yet, or the history couldn't be read): never "not used". */
  usage: { windowDays: number; scope: PhoneUsageScope; byId: Record<string, ResourceUsage> } | null;
}

export type PhoneResourceDetail = ResourceDetail;
export type PhoneResourceFile = ResourceFileContent;

/** The Mac's cloud connection, as a phone may know it. */
export type PhoneCloudLinkState = 'not-connected' | 'unchecked' | 'connected' | 'offline' | 'revoked';

export interface PhoneCloudLink {
  connected: boolean;
  state: PhoneCloudLinkState;
  /** What went wrong, in AASC's own words; null when nothing did. */
  problem: string | null;
  /** When this answer was read on the Mac (ISO); null when nothing was read. */
  readAt: string | null;
}

export interface PhoneSync extends PhoneCloudLink {
  items: SyncItem[];
}

export interface PhoneProjectLocal {
  state: CheckoutState;
  branch: string | null;
  /** The checkout's folder as a display path (`~/…`); null when it isn't on the Mac. */
  path: string | null;
  ahead: number | null;
  behind: number | null;
  account: string | null;
}

export interface PhoneProject {
  id: string;
  name: string;
  owner: string;
  repo: string;
  branch: string;
  /** Null when the Mac couldn't read the checkout this time. */
  local: PhoneProjectLocal | null;
}

export interface PhoneProjects extends PhoneCloudLink {
  accounts: GithubAccounts;
  projects: PhoneProject[];
  /** More projects than one answer carries. */
  truncated: boolean;
}
