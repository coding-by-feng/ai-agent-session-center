/**
 * `aasc send` and `aasc queue` (plan §9.8). "Send" has two meanings in AASC, so `aasc` has
 * two commands:
 *
 *   send   types the prompt now: POST /api/terminals/:id/write with the text, then a
 *          separate "\r" SUBMIT_ENTER_DELAY_MS later, exactly as the desktop's send-now
 *          does (src/lib/terminalSend.ts: a TUI reads text + "\r" in one write as a paste).
 *   queue  adds a paused item: POST /api/sessions/:id/queue/items. It sends from a
 *          dashboard that runs the queue.
 */
import { SUBMIT_ENTER_DELAY_MS } from '../../src/lib/terminalSend.js';
import { isSendableStatus } from './sessions.js';
import { serverCode, serverError, type ApiAnswer, type Requester } from './http.js';
import { EXIT } from './exitCodes.js';
import { cleanText } from './sanitize.js';

export interface SendDeps {
  request: Requester;
  sleep(ms: number): Promise<void>;
  /** Ask a y/N question; true only on an explicit yes. */
  confirm(question: string): Promise<boolean>;
  out(line: string): void;
}

export interface SendTarget {
  /** How the user named it, e.g. `vps:2`: used in messages. */
  ref: string;
  session: { sessionId: string; status: string; terminalId?: string | null };
}

/** An exit code and a sentence for a refused call. */
function refusal(a: ApiAnswer, target: SendTarget): { code: number; message: string } {
  const said = serverError(a.data);
  if (a.status === 404) return { code: EXIT.NOT_FOUND, message: `${target.ref} isn’t there any more, or isn’t shared with this computer.` };
  if (a.status === 401) return { code: EXIT.NOT_SIGNED_IN, message: `${target.ref}: the server didn’t accept this computer’s sign-in.` };
  if (a.status === 409 && serverCode(a.data) === 'CONTROL_HELD') {
    return { code: EXIT.USAGE, message: `${target.ref}: ${said ?? 'another device holds this session.'}` };
  }
  return { code: EXIT.USAGE, message: `${target.ref}: the server refused (${a.status})${said ? `: ${said}` : '.'}` };
}

function write(deps: SendDeps, terminalId: string, data: string): Promise<ApiAnswer> {
  return deps.request('POST', `/api/terminals/${encodeURIComponent(terminalId)}/write`, { data });
}

export async function sendNow(deps: SendDeps, target: SendTarget, text: string, opts: { force: boolean }): Promise<number> {
  if (!text) {
    deps.out('Nothing to send. Usage: aasc send <session> "text"');
    return EXIT.USAGE;
  }
  const terminalId = target.session.terminalId;
  if (!terminalId) {
    deps.out(`${target.ref} has no terminal to type into.`);
    return EXIT.NOT_FOUND;
  }
  if (!opts.force && !isSendableStatus(target.session.status)) {
    const yes = await deps.confirm(`${target.ref} is ${cleanText(target.session.status)}. Send anyway?`);
    if (!yes) {
      deps.out('Not sent. (--force sends without asking.)');
      return EXIT.USAGE;
    }
  }
  const typed = await write(deps, terminalId, text);
  if (typed.status !== 200) {
    const r = refusal(typed, target);
    deps.out(r.message);
    return r.code;
  }
  // A separate Enter, after the TUI has taken the text in.
  await deps.sleep(SUBMIT_ENTER_DELAY_MS);
  const entered = await write(deps, terminalId, '\r');
  if (entered.status !== 200) {
    const r = refusal(entered, target);
    deps.out(`Typed, but Enter failed. ${r.message}`);
    return r.code;
  }
  deps.out(`✓ sent to ${target.ref}`);
  return EXIT.OK;
}

export async function queuePrompt(deps: Pick<SendDeps, 'request' | 'out'>, target: SendTarget, text: string): Promise<number> {
  if (!text) {
    deps.out('Nothing to queue. Usage: aasc queue <session> "text"');
    return EXIT.USAGE;
  }
  const a = await deps.request('POST', `/api/sessions/${encodeURIComponent(target.session.sessionId)}/queue/items`, { text });
  if (a.status !== 200) {
    const r = refusal(a, target);
    deps.out(r.message);
    return r.code;
  }
  deps.out(`✓ queued (paused) on ${target.ref}. It sends from a dashboard that runs the queue.`);
  return EXIT.OK;
}
