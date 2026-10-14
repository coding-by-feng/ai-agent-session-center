// keepAwakeService.ts — the one keep-awake controller (keepAwake.ts), over the live sessions.
import { getAllSessions } from './sessionStore.js';
import { createKeepAwake } from './keepAwake.js';

export const keepAwake = createKeepAwake(() => Object.values(getAllSessions()));
