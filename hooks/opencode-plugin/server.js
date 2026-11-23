// AI Agent Session Center — OpenCode 2.x server plugin (installed as ~/.config/opencode/plugins/aasc-dashboard/server.js).
//
// OpenCode has no shell hooks: a server plugin observes its event bus and hooks. This one turns them into the
// same queue lines the shell relays write (Claude event names, cli_source "opencode"). Verified against
// OpenCode 2.3.2 in tmux probes (Nov 23 2026):
//   - OpenCode runs its agent on a shared background server (`opencode serve --service`, parent pid 1) unless the
//     TUI is started with `--standalone`. That server has no terminal: its pid, tty and AGENT_MANAGER_TERMINAL_ID
//     are those of whichever terminal first started it. So this plugin reports ONLY when it runs in a standalone
//     server (`opencode serve --stdio`, a child of the TUI): it reports the TUI's pid and tty. AASC adds
//     `--standalone` to every local launch line (src/lib/agentKinds.ts withOpencodeStandalone);
//   - prompt text arrives through the `session.prompt` hook; tools through `tool.execute.before/after`; a
//     permission dialog as the `permission.asked` event; a turn ends with `session.execution.succeeded`,
//     `.failed` or `.interrupted` (Esc); the reply text comes as `session.text.ended`.
// It never changes what OpenCode does: every hook returns nothing and every error is swallowed.
import { appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// AASC_HOOK_MQ_DIR: tests only, so a run never writes the live queue.
const MQ_DIR = process.env.AASC_HOOK_MQ_DIR || '/tmp/claude-session-center';
const MQ_FILE = `${MQ_DIR}/queue.jsonl`;
const LITE = process.env.AASC_HOOK_LEVEL === 'lite';
const TERMINAL_ID = process.env.AGENT_MANAGER_TERMINAL_ID || null;

const TOOL_NAMES = {
  shell: 'Bash', bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit', multiedit: 'Edit',
  glob: 'Glob', list: 'Glob', grep: 'Grep', webfetch: 'WebFetch', websearch: 'WebSearch', subagent: 'Task', task: 'Task',
  todowrite: 'TodoWrite', todoread: 'TodoWrite',
};

export function toolName(name) {
  return TOOL_NAMES[String(name || '').toLowerCase()] || String(name || 'Tool');
}

export function toolInput(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (toolName(name) === 'Bash') return { command: String(i.command ?? '') };
  const out = {};
  const file = i.filePath ?? i.file_path ?? i.path;
  if (typeof file === 'string') out.file_path = file;
  const pattern = i.pattern ?? i.query;
  if (typeof pattern === 'string') out.pattern = pattern;
  if (typeof i.url === 'string') out.url = i.url;
  if (typeof i.description === 'string') out.description = i.description;
  return out;
}

/** The TUI this server runs under: pid, tty and launch line; null on the shared background server. */
export function readHost(ppid = process.ppid, ps = defaultPs) {
  if (!ppid || ppid === 1) return null;
  const args = ps(['-o', 'args=', '-p', String(ppid)]).trim();
  // Only a TUI owns this server. A server under anything else (a launchd job, another tool) is not ours to bind.
  if (!/(^|\/)opencode(\s|$)/.test(args.split(/\s+/)[0] || '') || /\sserve(\s|$)/.test(args)) return null;
  const rawTty = ps(['-o', 'tty=', '-p', String(ppid)]).trim();
  const tty = rawTty && rawTty !== '??' && rawTty !== '?' ? `/dev/${rawTty}` : null;
  return { pid: ppid, tty, command: args };
}

function defaultPs(args) {
  try { return execFileSync('ps', args, { encoding: 'utf8', timeout: 2000 }); } catch { return ''; }
}

function write(line) {
  try {
    if (existsSync(MQ_DIR)) {
      // One write per line: parallel writers must never interleave a torn line (dashboard-hook-codex.sh mq_append).
      appendFileSync(MQ_FILE, `${line}\n`);
    } else if (typeof fetch === 'function') {
      fetch('http://localhost:3333/api/hooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: line })
        .catch(() => {});
    }
  } catch { /* never disturb OpenCode */ }
}

/**
 * The event → queue-line translator, separate from OpenCode's plugin API so tests can drive it.
 * `emit` receives each line's object.
 */
export function createRelay({ host, emit, now = () => Date.now(), lite = LITE, terminalId = TERMINAL_ID }) {
  const started = new Set();
  const children = new Set();
  const lastText = new Map();
  const running = new Set();
  const cwdOf = new Map();

  const base = (sessionID, event) => ({
    hook_event_name: event,
    session_id: sessionID,
    cwd: cwdOf.get(sessionID) ?? null,
    claude_pid: host.pid,
    hook_sent_at: now(),
    tty_path: host.tty,
    agent_terminal_id: terminalId,
    cli_source: 'opencode',
    ...(host.command && /(^|\s)--auto(\s|$)/.test(host.command) ? { permission_mode: 'auto' } : { permission_mode: 'default' }),
  });

  const send = (obj) => {
    const clean = Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
    emit(clean);
  };

  // A session seen for the first time gets its SessionStart first (a resumed `-s <id>` sends no session.created).
  const ensureStarted = (sessionID, extra = {}) => {
    if (!sessionID || started.has(sessionID) || children.has(sessionID)) return;
    started.add(sessionID);
    send({ ...base(sessionID, 'SessionStart'), source: 'startup', startup_command: host.command || null, ...extra });
  };

  const ours = (sessionID) => !!sessionID && !children.has(sessionID);

  return {
    onEvent(ev) {
      const type = ev?.type;
      const d = ev?.data ?? ev?.properties ?? {};
      const sessionID = d.sessionID;
      if (!type) return;
      if (type === 'session.created') {
        // A subagent's session (a parent id, or one created while another session of this TUI is mid-turn)
        // must never become the card: its events would re-key it away from the session on screen.
        const parent = d.parentID ?? d.parentSessionID ?? d.parent ?? null;
        if (parent || (running.size > 0 && !running.has(sessionID))) { children.add(sessionID); return; }
        if (d.location?.directory) cwdOf.set(sessionID, d.location.directory);
        ensureStarted(sessionID, { model: d.model?.id ?? null });
        return;
      }
      if (!ours(sessionID)) return;
      if (type === 'session.execution.started') { running.add(sessionID); return; }
      if (type === 'session.text.ended' && typeof d.text === 'string' && d.text.trim()) { lastText.set(sessionID, d.text); return; }
      if (type === 'permission.asked') {
        ensureStarted(sessionID);
        const resources = Array.isArray(d.resources) ? d.resources : [];
        const name = toolName(d.action);
        send({
          ...base(sessionID, 'PermissionRequest'),
          tool_name: name,
          tool_input: name === 'Bash' ? { command: String(resources[0] ?? '') } : { file_path: resources[0] ?? null },
          agent_tool: d.action ?? null,
        });
        return;
      }
      if (type === 'session.execution.succeeded' || type === 'session.execution.failed' || type === 'session.execution.interrupted') {
        running.delete(sessionID);
        ensureStarted(sessionID);
        const reason = type.endsWith('succeeded') ? 'end_turn' : type.endsWith('interrupted') ? 'USER_CANCELED' : 'ERROR';
        send({
          ...base(sessionID, 'Stop'),
          response: lastText.get(sessionID) ?? null,
          stop_reason: reason,
          error: type.endsWith('failed') ? (d.error?.message ?? 'failed').slice(0, 500) : null,
        });
        lastText.delete(sessionID);
        return;
      }
      if (type === 'session.deleted') {
        if (started.has(sessionID)) send(base(sessionID, 'SessionEnd'));
        started.delete(sessionID);
      }
    },
    onPrompt(event) {
      const sessionID = event?.sessionID;
      if (!ours(sessionID)) return;
      ensureStarted(sessionID);
      send({ ...base(sessionID, 'UserPromptSubmit'), prompt: String(event?.prompt?.text ?? '') });
    },
    onToolBefore(event) {
      if (lite || !ours(event?.sessionID)) return;
      ensureStarted(event.sessionID);
      send({ ...base(event.sessionID, 'PreToolUse'), tool_name: toolName(event.tool), tool_input: toolInput(event.tool, event.input ?? event.args), agent_tool: event.tool ?? null });
    },
    onToolAfter(event) {
      if (lite || !ours(event?.sessionID)) return;
      const failed = event?.status === 'error';
      send({
        ...base(event.sessionID, failed ? 'PostToolUseFailure' : 'PostToolUse'),
        tool_name: toolName(event.tool),
        agent_tool: event.tool ?? null,
        error: failed ? String(event?.error?.message ?? 'error').slice(0, 500) : null,
      });
    },
    onShutdown() {
      for (const sessionID of started) send(base(sessionID, 'SessionEnd'));
      started.clear();
    },
  };
}

export default {
  id: 'aasc-dashboard',
  async setup(ctx) {
    const host = readHost();
    if (!host) return undefined; // the shared background server: no terminal to report (see the header)
    const relay = createRelay({ host, emit: (obj) => write(JSON.stringify(obj)) });
    const safe = (fn) => (arg) => { try { fn(arg); } catch { /* never disturb OpenCode */ } };
    const disposers = [];
    const hook = async (domain, name, fn) => {
      try {
        const reg = await ctx?.[domain]?.hook?.(name, safe(fn));
        if (reg && typeof reg.dispose === 'function') disposers.push(() => reg.dispose());
      } catch { /* an older or newer OpenCode without this hook */ }
    };
    await hook('session', 'prompt', relay.onPrompt);
    await hook('tool', 'execute.before', relay.onToolBefore);
    await hook('tool', 'execute.after', relay.onToolAfter);
    const abort = new AbortController();
    (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: abort.signal })) safe(relay.onEvent)(ev);
      } catch { /* stream closed */ }
    })();
    const onExit = safe(() => relay.onShutdown());
    process.once('exit', onExit);
    return () => {
      abort.abort();
      process.removeListener('exit', onExit);
      relay.onShutdown();
      for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    };
  },
};
