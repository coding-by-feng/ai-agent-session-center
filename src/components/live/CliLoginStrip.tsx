/**
 * CliLoginStrip — "Claude Code isn't logged in on <host> · Log in" over the LIVE page (Oct 29 2026).
 *
 * Shown for an enabled CLI the host reports logged out (useCliAuth), on this machine and in a remote
 * computer's window alike: on a headless server another device is the only screen there is. "Log in"
 * opens a terminal on the host running the CLI's login (server/cliLoginTerminal.ts) and opens it here.
 * Lazy in LiveView, so the entry chunk doesn't carry it.
 */
import Button from '@/components/ui/Button';
import { useCliAuth } from '@/hooks/useCliAuth';
import { loginNeededTitle } from '@/lib/cliAuthClient';
import { useSessionStore } from '@/stores/sessionStore';
import { CLI_AUTH_LABELS } from '@/types/cliAuth';
import styles from '@/styles/modules/CliLoginStrip.module.css';

/** inline: in the page's flow above the board. over: floating at the top of the 3D scene. */
export default function CliLoginStrip({ placement = 'inline' }: { placement?: 'inline' | 'over' }) {
  const { host, needed, starting, error, login } = useCliAuth();
  if (needed.length === 0) return null;

  const onLogin = async (cli: (typeof needed)[number]['cli']) => {
    const result = await login(cli);
    if (result.ok) useSessionStore.getState().selectSession(result.terminalId);
  };

  return (
    <div className={`${styles.strip} ${styles[placement]}`} role="status" data-testid="cli-login-strip">
      <span className={styles.icon} aria-hidden="true">!</span>
      <div className={styles.text}>
        <strong className={styles.title}>{loginNeededTitle(needed, host)}</strong>
        <span className={styles.lead}>
          {error ?? 'Sessions fail until you log in. Log in opens a terminal on that machine.'}
        </span>
      </div>
      <div className={styles.actions}>
        {needed.map((c) => (
          <Button
            key={c.cli}
            size="sm"
            variant="primary"
            disabled={starting !== null}
            onClick={() => { void onLogin(c.cli); }}
          >
            {starting === c.cli ? 'Opening…' : needed.length > 1 ? `Log in to ${CLI_AUTH_LABELS[c.cli]}` : 'Log in'}
          </Button>
        ))}
      </div>
    </div>
  );
}
