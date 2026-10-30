import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import clientCore from './client.cjs';
import fileStorage from './file-store.cjs';
const { createTrialClient, TrialClientError, sanitizeTerminalText } = clientCore;
const { createFileTrialStore } = fileStorage;

const HELP = `AASC 原生问答体验\n\n用法：ai-agent-session-center trial <命令>\n\n  activate  从标准输入或交互输入读取体验码并激活\n  status    查看服务、剩余次数和当前任务状态\n  ask       从标准输入或交互输入读取一个问题\n  history   从服务读取对话记录\n  retry     确认结果，必要时重试同一条待确认请求\n  logout    退出体验并清除本机体验凭据\n  help      显示帮助\n\n体验共 3 次回复，仅限问答：解释概念、短报错和方案比较。\n不能修改文件、运行命令或操作项目；不会启动本地终端或安装代理。\n问题最多 600 字符，实际限制以服务状态为准。\n请通过标准输入或交互输入提供体验码和问题，不要放入命令参数。\n请求中断后先用 status/history 查看，再手动 retry；不会自动重新提交。\n`;
const ERRORS = {
  runtime_unavailable: '体验服务暂未开放，请保留体验码并联系官方客服。',
  code_unavailable: '此体验码暂不可用，请检查输入或联系官方客服。',
  network_error: '暂时无法确认请求结果。请用 status/history 查看；若仍待确认，请手动 retry。',
  invalid_response: '服务响应无法验证，请稍后查看状态；待确认请求会保留。',
  invalid_request: '请检查输入，每次只输入一个体验码或一个简短问题。',
  invalid_input: '输入过长或为空，请检查输入。',
  invalid_prompt: '问题为空或超过服务允许的长度，请缩短后再试。',
  trial_scope_restricted: '体验仅限问答，请询问概念、短报错或方案比较。',
  turn_pending: '上一条请求仍在处理中或待核实。请用 status/history 查看，或用 retry 确认同一请求。',
  unauthorized: '尚未激活或体验访问已结束，请激活体验码或联系官方客服恢复访问。',
  trial_expired: '体验期限已结束，仍可通过 history 查看记录。',
  trial_revoked: '此体验已被撤销，请联系官方客服。',
  quota_exhausted: '3 次体验已用完，仍可通过 history 查看记录。',
  rate_limited: '请求较频繁，请稍后查看状态。待确认请求会保留。',
  runtime_busy: '体验服务当前繁忙，请稍后查看状态。待确认请求会保留。',
  daily_budget_exhausted: '今日体验容量已满，请稍后再试。待确认请求会保留。',
  idempotency_conflict: '请求与先前记录不一致，请查看 history 或联系官方客服。',
  storage_error: '无法安全读取或保存本机体验凭据，请检查 ~/.config/aasc 的权限和可用空间。',
  client_locked: '另一个 AASC 体验命令正在运行，请待其结束后再试。',
  client_busy: '当前体验请求仍在进行中，请稍后再试。',
  credential_missing: '服务未建立体验访问凭据，请稍后再试。',
  credential_changed: '体验访问身份发生变化，请联系官方客服核实待确认请求。',
};
const STATE = {
  active: '可继续问答',
  expired: '已过期',
  exhausted: '次数已用完',
  revoked: '已撤销',
};
const TURN = {
  pending: '等待回复',
  completed: '已完成',
  failed: '未完成',
  uncertain: '待客服核实',
};

async function readInput(input, output, secret) {
  if (input.isTTY) {
    output.write(secret ? '请输入体验码（输入不显示）：' : '请输入你的问题：');
    const sink = secret
      ? new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        })
      : output;
    const rl = createInterface({ input, output: sink, terminal: true });
    try {
      const value = await rl.question('');
      if (secret) output.write('\n');
      return value;
    } finally {
      rl.close();
    }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) throw new TrialClientError('invalid_input');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}
function printSession(output, snapshot, history = false, lastOnly = false) {
  const write = (line) => output.write(`${sanitizeTerminalText(line)}\n`);
  if (snapshot.status)
    write(
      `体验服务：${snapshot.status.available ? '已开放' : '暂未开放'}；每次输入最多 ${snapshot.status.inputLimit} 字符。`,
    );
  if (!snapshot.session) write('尚未激活体验。请运行 ai-agent-session-center trial activate。');
  else {
    const session = snapshot.session;
    write(`体验编号：${session.id}`);
    write(`剩余回复：${session.remaining} / 3；状态：${STATE[session.state]}`);
    if (history || lastOnly) {
      const turns = lastOnly ? session.turns.slice(-1) : session.turns;
      if (!turns.length) write('暂无对话记录。');
      for (const turn of turns) {
        write(`\n你：${turn.prompt}`);
        write(`Claude Code [${TURN[turn.status]}]：${turn.answer || ''}`);
        if (turn.truncated) write('本次已达到回复长度上限。');
      }
    }
    if (
      session.reserved ||
      session.turns.some((turn) => ['pending', 'uncertain'].includes(turn.status))
    )
      write('有请求处理中或待核实，请运行 history 查看结果。');
  }
  if (snapshot.pending)
    write('本机保留了一条待确认请求。请先查看 history，必要时运行 retry 确认同一请求。');
}

export async function runTrialCli(args = [], options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const errors = options.errorOutput || process.stderr;
  const command = args[0] || 'help';
  if (
    args.length > 1 ||
    !['activate', 'status', 'ask', 'history', 'retry', 'logout', 'help', '--help', '-h'].includes(
      command,
    )
  ) {
    errors.write(
      '用法：ai-agent-session-center trial <命令>。体验码和问题仅通过标准输入或交互输入提供。\n',
    );
    return 2;
  }
  if (['help', '--help', '-h'].includes(command)) {
    output.write(HELP);
    return 0;
  }
  let release;
  try {
    const store = options.store || createFileTrialStore();
    release = store.acquireLock();
    const client = options.client || createTrialClient({ store });
    if (command === 'activate') {
      const snapshot = await client.activate(await readInput(input, output, true));
      output.write('体验已激活。仅限问答，请勿输入密码、密钥或个人敏感资料。\n');
      printSession(output, snapshot);
    } else if (command === 'ask')
      printSession(output, await client.ask(await readInput(input, output, false)), false, true);
    else if (command === 'retry') printSession(output, await client.retry(), false, true);
    else if (command === 'status') {
      await client.status();
      printSession(output, await client.state());
    } else if (command === 'history') printSession(output, await client.state(), true);
    else if (command === 'logout') {
      await client.logout();
      output.write('已退出体验并清除本机体验凭据。\n');
    }
    return 0;
  } catch (error) {
    errors.write(
      `${ERRORS[error instanceof TrialClientError ? error.code : ''] || '暂时无法继续，请稍后查看状态或联系官方客服。'}\n`,
    );
    return 1;
  } finally {
    release?.();
  }
}
