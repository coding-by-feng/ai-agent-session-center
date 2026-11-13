/**
 * useCliAuth — which enabled agent CLIs are logged out on the host, and a way to log in.
 *
 * Asks on mount, every CLI_AUTH_POLL_MS and when the window comes back into view. After "Log in" it asks
 * again (with refresh) every CLI_AUTH_FAST_POLL_MS for CLI_AUTH_FAST_WINDOW_MS, so the strip clears soon
 * after the login finishes in its terminal.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CLI_AUTH_FAST_POLL_MS,
  CLI_AUTH_FAST_WINDOW_MS,
  CLI_AUTH_POLL_MS,
  fetchCliAuth,
  startCliLogin,
  type StartLoginResult,
} from '@/lib/cliAuthClient';
import { cliLoginsNeeded, type CliAuthReport } from '@/types/cliAuth';
import type { AgentCli } from '@/types/cliVersions';

export function useCliAuth() {
  const [report, setReport] = useState<CliAuthReport | null>(null);
  const [starting, setStarting] = useState<AgentCli | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fastUntil = useRef(0);

  useEffect(() => {
    let alive = true;
    // Set only from the answer's callback. An unanswered check keeps the last answer: a blip must not
    // hide or show the strip.
    const ask = (refresh: boolean) => {
      void fetchCliAuth(refresh).then((next) => { if (alive && next) setReport(next); });
    };
    const tick = () => ask(Date.now() < fastUntil.current);
    ask(false);
    const slow = setInterval(tick, CLI_AUTH_POLL_MS);
    const quick = setInterval(() => { if (Date.now() < fastUntil.current) tick(); }, CLI_AUTH_FAST_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(slow);
      clearInterval(quick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const login = useCallback(async (cli: AgentCli): Promise<StartLoginResult> => {
    setStarting(cli);
    setError(null);
    const result = await startCliLogin(cli);
    setStarting(null);
    if (result.ok) fastUntil.current = Date.now() + CLI_AUTH_FAST_WINDOW_MS;
    else setError(result.error);
    return result;
  }, []);

  return { host: report?.host ?? '', needed: cliLoginsNeeded(report), starting, error, login };
}
