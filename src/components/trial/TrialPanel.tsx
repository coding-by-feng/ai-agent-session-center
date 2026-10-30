import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeTrialAPI, TrialResult, TrialSnapshot } from '@/types/trial';
import styles from './Trial.module.css';

const EMPTY: TrialSnapshot = { status: null, session: null, pending: null, busy: false };
const MESSAGES: Record<string, string> = {
  network_error: '连接中断。请刷新状态；未确认的问题只能重试原请求，不会重复扣次。',
  runtime_unavailable: '体验服务暂未开放，请稍后再试。',
  native_runtime_required: '请更新 AASC 后重试。',
  code_unavailable: '体验码无效、已使用或已过期，请联系客服。',
  trial_scope_restricted: '体验仅限问答。请改为概念解释、使用方法或报错说明。',
  turn_pending: '上一条问题还在确认中，请先刷新状态。',
  client_busy: '正在同步，请稍后再试。',
  quota_exhausted: '三次体验已用完。',
  trial_expired: '体验已到期，请联系客服。',
  trial_revoked: '此体验已停用，请联系客服。',
  daily_budget_exhausted: '今日体验名额已满，请稍后再试。',
  runtime_busy: '当前有人正在体验，请稍后重试同一问题。',
  rate_limited: '请求较频繁，请稍后重试同一问题。',
  unauthorized: '体验凭证已失效，请联系客服恢复；恢复不会重置次数。',
  credential_store_unavailable: '系统安全存储不可用。请解锁系统钥匙串后重试。',
  credential_store_invalid: '本机体验凭证无法读取，请联系客服恢复。',
  storage_error: '本机体验凭证无法保存，请检查磁盘权限后重试。',
  credential_changed: '体验凭证已变更，请联系客服确认未完成的问题。',
  invalid_prompt: '请输入 1–600 个字符。',
};

export default function TrialPanel({ api }: { api: NativeTrialAPI }) {
  const [snapshot, setSnapshot] = useState<TrialSnapshot>(EMPTY);
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [confirmLogout, setConfirmLogout] = useState(false);
  const epoch = useRef(0);
  const alive = useRef(true);
  const mutation = useRef(false);
  const refreshing = useRef(false);
  const apply = useCallback((result: TrialResult, serial: number) => {
    if (!alive.current || serial !== epoch.current) return;
    if (result.data) setSnapshot(result.data);
    setError(result.ok ? '' : (MESSAGES[result.error] ?? '暂时无法完成，请刷新状态后重试。'));
  }, []);
  const refresh = useCallback(async () => {
    if (mutation.current || refreshing.current) return;
    refreshing.current = true;
    const serial = ++epoch.current;
    try {
      apply(await api.refresh(), serial);
    } catch {
      if (alive.current && serial === epoch.current) setError(MESSAGES.network_error);
    } finally {
      refreshing.current = false;
    }
  }, [api, apply]);
  const invalidate = useCallback(() => {
    alive.current = false;
    epoch.current++;
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      invalidate();
      clearInterval(timer);
    };
  }, [refresh, invalidate]);
  async function run(operation: () => Promise<TrialResult>, success?: () => void) {
    if (mutation.current) return;
    mutation.current = true;
    const serial = ++epoch.current;
    setWorking(true);
    setError('');
    try {
      const result = await operation();
      apply(result, serial);
      if (result.ok && alive.current && serial === epoch.current) success?.();
    } catch {
      if (alive.current && serial === epoch.current) setError(MESSAGES.network_error);
    } finally {
      mutation.current = false;
      if (alive.current && serial === epoch.current) setWorking(false);
    }
  }
  const { session, pending, status } = snapshot;
  const available = status?.available === true;
  const locked =
    working ||
    snapshot.busy ||
    !!pending ||
    !!session?.reserved ||
    session?.state !== 'active' ||
    !available;
  const limit = status?.inputLimit ?? 600;
  return (
    <div className={styles.panel}>
      <div className={styles.summary}>
        <strong>{session ? `剩余 ${session.remaining} / 3 次` : '三次简短问答'}</strong>
        <span>Claude Code · AASC 客户端</span>
      </div>
      <p className={styles.note}>
        问概念、问用法、看报错。每题最多 600
        个字符，回复有长度限制。不读取项目、不改文件、不运行命令。
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {status && !available && !error && (
        <p className={styles.note} role="status">
          体验服务暂未开放，请稍后再试。
        </p>
      )}
      {!session ? (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (available && consent && code.trim())
              void run(
                () => api.activate(code.trim()),
                () => setCode(''),
              );
          }}
        >
          <label>
            体验码
            <input
              aria-label="体验码"
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={80}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={working}
            />
          </label>
          <label className={styles.consent}>
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>我已了解：仅限问答；每条有效回复计一次，达到长度上限的回复也计一次。</span>
          </label>
          <button
            className={styles.primary}
            disabled={working || !available || !consent || !code.trim()}
          >
            开始体验
          </button>
          <p className={styles.note}>
            向官方客服领取体验码。已在其他客户端激活的体验，请联系客服转移，次数不会重置。
          </p>
        </form>
      ) : (
        <>
          <div className={styles.history} aria-label="体验记录" aria-live="polite">
            {session.turns.map((turn) => (
              <article key={turn.id} className={styles.turn}>
                <p className={styles.question}>{turn.prompt}</p>
                {turn.answer && <p className={styles.answer}>{turn.answer}</p>}
                {turn.truncated === 1 && (
                  <p className={styles.note}>回复已达到长度上限，本次已计入体验。</p>
                )}
                {turn.status === 'pending' && <p className={styles.note}>正在回答，请稍候…</p>}
                {turn.status === 'uncertain' && (
                  <p className={styles.note}>
                    结果待确认，本次暂时占用一个名额。请联系客服，不要重复提交。
                  </p>
                )}
                {turn.status === 'failed' && (
                  <p className={styles.note}>本次未完成，未扣次数。请稍后再试。</p>
                )}
              </article>
            ))}
          </div>
          {session.state !== 'active' && (
            <p className={styles.note} role="status">
              {session.state === 'exhausted'
                ? '三次体验已用完。'
                : session.state === 'expired'
                  ? '体验已到期。'
                  : '此体验已停用。'}{' '}
              可前往官网联系客服。
            </p>
          )}
          {pending && (
            <div className={styles.pending} role="status">
              <p>问题已保存，等待确认：{pending.prompt}</p>
              <button
                disabled={working}
                onClick={() =>
                  void run(
                    () => api.retry(),
                    () => setPrompt(''),
                  )
                }
              >
                重试同一问题
              </button>
            </div>
          )}
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              if (!locked && prompt.trim())
                void run(
                  () => api.ask(prompt.trim()),
                  () => setPrompt(''),
                );
            }}
          >
            <label>
              输入问题
              <textarea
                aria-label="输入问题"
                rows={3}
                maxLength={limit}
                disabled={locked}
                placeholder="例如：这条报错是什么意思？"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
            <div className={styles.row}>
              <span className={styles.note}>
                {prompt.length} / {limit}
              </span>
              <button className={styles.primary} disabled={locked || !prompt.trim()}>
                发送问题
              </button>
            </div>
          </form>
          <p className={styles.note}>
            有效期至 {new Date(session.expiresAt).toLocaleDateString('zh-CN')}。记录保留至{' '}
            {new Date(session.transcriptExpiresAt).toLocaleDateString('zh-CN')}。
          </p>
          {confirmLogout ? (
            <div className={styles.pending}>
              <p>退出后需要联系客服恢复访问，剩余次数不会重置。</p>
              <div className={styles.row}>
                <button onClick={() => setConfirmLogout(false)}>取消</button>
                <button
                  disabled={working}
                  onClick={() =>
                    void run(
                      () => api.logout(),
                      () => {
                        setConfirmLogout(false);
                        setPrompt('');
                        setCode('');
                        setConsent(false);
                      },
                    )
                  }
                >
                  确认退出
                </button>
              </div>
            </div>
          ) : (
            <button
              className={styles.quiet}
              disabled={working}
              onClick={() => setConfirmLogout(true)}
            >
              退出体验
            </button>
          )}
        </>
      )}
      <div className={styles.footer}>
        <button className={styles.quiet} disabled={working} onClick={() => void refresh()}>
          刷新状态
        </button>
        <a href="https://xclaude.dev/support/" target="_blank" rel="noreferrer">
          官方客服 ↗
        </a>
      </div>
    </div>
  );
}
