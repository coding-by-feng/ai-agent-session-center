// tools/cloudP6.ts — the cloud toolset's P6 tools (plan 2026-10-25), one list: the jobs (cloudJobs.ts), sync
// (cloudSync.ts), publish and install (cloudPublish.ts), project records (cloudProjectWrite.ts) and checkouts
// (cloudProjectGit.ts), and aliases and remote access (cloudAliases.ts). cloud.ts puts it at the end of `cloudTools`.
// Every tool here is phase 6 (test/mcp/cloudToolSources.test.ts), so none is listed until the build's phase is.

import type { ToolDef } from '../registry.js';
import { cloudAliasTools } from './cloudAliases.js';
import { cloudJobTools } from './cloudJobs.js';
import { cloudProjectGitTools } from './cloudProjectGit.js';
import { cloudProjectWriteTools } from './cloudProjectWrite.js';
import { cloudPublishTools } from './cloudPublish.js';
import { cloudSyncTools } from './cloudSync.js';

export const cloudP6Tools: readonly ToolDef[] = [
  ...cloudSyncTools,
  ...cloudPublishTools,
  ...cloudJobTools,
  ...cloudProjectWriteTools,
  ...cloudProjectGitTools,
  ...cloudAliasTools,
];
