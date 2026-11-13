// cliLoginTerminal.ts — open a terminal on this machine that runs an agent CLI's login (Oct 29 2026).
//
// The terminal is a plain shell (`command: ''`, so no agent-launch rewriting) in the home folder; the
// login line, fixed here and never taken from a request, is typed raw once the prompt is ready. It ends
// with `&& exit`: a finished login closes the shell, so the card ends and is never restored as an agent.
// A failed one leaves the shell open with the CLI's error on screen.
//
// Codex's browser login answers on localhost:1455, which works only from a browser on this machine; any
// other caller (a phone, another computer, a headless server) gets `--device-auth` (a URL and a code).

import { homedir } from 'os';
import { createTerminal, getTerminals, writeWhenReady } from './sshManager.js';
import { createTerminalSession } from './sessionStore.js';
import { checkTerminalCapacity } from './terminalCapacity.js';
import * as presence from './presenceManager.js';
import { isHeadless } from './edition.js';
import { CLI_AUTH_LABELS } from '../src/types/cliAuth.js';
import type { AgentCli } from '../src/types/cliVersions.js';
import type { LoginRequest } from './cliAuthRouter.js';
import type { TerminalConfig } from '../src/types/terminal.js';

/** The login line for a caller. Only fixed strings: nothing from the request is ever part of it. */
export function loginLineFor(cli: AgentCli, { isLocal, headless }: { isLocal: boolean; headless: boolean }): string {
  if (cli === 'claude') return 'claude auth login';
  return isLocal && !headless ? 'codex login' : 'codex login --device-auth';
}

export async function openCliLoginTerminal(cli: AgentCli, { isLocal, clientId }: LoginRequest): Promise<{ terminalId: string }> {
  const capacity = checkTerminalCapacity(getTerminals(), { sessions: 1 });
  if (!capacity.ok) throw Object.assign(new Error(capacity.error), { status: 429 });

  const config: TerminalConfig = {
    host: 'localhost',
    workingDir: homedir(),
    command: '',
    label: `Log in to ${CLI_AUTH_LABELS[cli]}`,
  };
  const terminalId = await createTerminal(config, null);
  // A remote caller's terminal is shared with it, or it could never see the terminal it asked for.
  await createTerminalSession(terminalId, isLocal ? config : { ...config, remoteVisible: true });
  if (clientId) presence.noteControlActivity(terminalId, clientId);
  void writeWhenReady(terminalId, `${loginLineFor(cli, { isLocal, headless: isHeadless() })} && exit\r`, { raw: true });
  return { terminalId };
}
