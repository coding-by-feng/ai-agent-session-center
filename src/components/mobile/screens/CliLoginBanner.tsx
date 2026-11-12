/**
 * CliLoginBanner — the phone's "Claude Code isn't logged in on <host>" with Log in (Oct 29 2026), under
 * the Sessions nav bar. Log in opens a terminal on the host running the CLI's login and shows it here,
 * so a headless server can be signed in from the phone. The desktop's twin is live/CliLoginStrip.
 */
import { Banner } from '../kit';
import { useCliAuth } from '@/hooks/useCliAuth';
import { loginNeededTitle } from '@/lib/cliAuthClient';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { CLI_AUTH_LABELS } from '@/types/cliAuth';

export default function CliLoginBanner() {
  const { host, needed, starting, error, login } = useCliAuth();
  if (needed.length === 0) return null;
  const first = needed[0].cli;
  const onLogin = async () => {
    const result = await login(first);
    // A login terminal is a plain shell: it has no Chat, so it opens on its Terminal.
    if (result.ok) usePhoneNavStore.getState().openTerminal(result.terminalId, false);
  };
  return (
    <Banner
      tone="warning"
      title={loginNeededTitle(needed, host)}
      action={{ label: needed.length > 1 ? `Log in to ${CLI_AUTH_LABELS[first]}` : 'Log in', onClick: () => { void onLogin(); }, loading: starting !== null }}
    >
      {error ?? 'Sessions fail until you log in.'}
    </Banner>
  );
}
