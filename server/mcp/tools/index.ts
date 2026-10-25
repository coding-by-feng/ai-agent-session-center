// tools/index.ts — every tool the /mcp endpoint can offer, filed by toolset.
//
// One list per toolset, and each toolset's module fills in only its own line: Task 8 adds sessions,
// conversation, prompts, requests and system (plus `scope_get` and `central_list`), Task 9 the rest. A
// toolset whose tools have not landed yet stays an empty list. registry.ts reads this object and nothing
// else, so adding a toolset's tools never touches another toolset's line or the registry.
//
// A tool module imports `ToolDef` from ../registry.js with `import type` only: registry.ts imports this
// file, so a runtime import back into it would be a cycle. test/mcp/registry.test.ts checks every list:
// each tool under its own toolset, once, with a unique name.

import type { ToolDef } from '../registry.js';
import type { Toolset } from '../types.js';
import { agendaTools } from './agenda.js';
import { cloudTools } from './cloud.js';
import { conversationTools } from './conversation.js';
import { historyTools } from './history.js';
import { noteTools } from './notes.js';
import { promptTools } from './prompts.js';
import { queueTools } from './queue.js';
import { queueWriteTools } from './queueWrite.js';
import { requestTools } from './requests.js';
import { resourceTools } from './resources.js';
import { roomTools } from './rooms.js';
import { routingTools } from './routing.js';
import { sessionCreateTools } from './sessionCreate.js';
import { sessionTools } from './sessions.js';
import { skillNoteTools } from './skillNotes.js';
import { snippetTools } from './snippets.js';
import { systemTools } from './system.js';
import { taskTools } from './tasks.js';

export const toolsByToolset: Readonly<Record<Toolset, readonly ToolDef[]>> = Object.freeze({
  sessions: [...sessionTools, ...sessionCreateTools],
  conversation: conversationTools,
  prompts: promptTools,
  tasks: [...taskTools, ...routingTools],
  requests: requestTools,
  queue: [...queueTools, ...queueWriteTools],
  rooms: roomTools,
  resources: resourceTools,
  skillNotes: skillNoteTools,
  snippets: snippetTools,
  history: historyTools,
  notes: noteTools,
  agenda: agendaTools,
  cloud: cloudTools,
  system: systemTools,
});
