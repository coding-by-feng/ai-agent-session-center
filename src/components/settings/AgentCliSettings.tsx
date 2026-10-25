/**
 * Settings ▸ ADVANCED ▸ Agent CLIs (Oct 25 2026): the Claude Code and Codex this Mac's terminals
 * start, the newest version on npm, and an Update button that runs the CLI's own updater on the
 * Mac. Progress arrives on the WebSocket (`cli_update`), so every open window follows along; the
 * running update's elapsed time and live output show under its row (`CliUpdateLog`).
 */
import { useCliVersionsStore } from '@/stores/cliVersionsStore';
import { useCliVersionsLive } from '@/hooks/useCliVersionsLive';
import { describeCli, type CliTone } from '@/lib/cliVersionsView';
import CliUpdateLog from './CliUpdateLog';
import { showToast } from '@/components/ui/ToastContainer';
import type { AgentCli } from '@/types/cliVersions';
import styles from '@/styles/modules/Settings.module.css';

const TONE_CLASS: Record<CliTone, string> = {
  neutral: styles.cliDotNeutral,
  available: styles.cliDotAvailable,
  busy: styles.cliDotBusy,
  ok: styles.cliDotOk,
  error: styles.cliDotError,
};

const checkedLabel = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function AgentCliSettings() {
  const items = useCliVersionsStore((s) => s.items);
  const loading = useCliVersionsStore((s) => s.loading);
  const error = useCliVersionsStore((s) => s.error);
  const load = useCliVersionsStore((s) => s.load);
  const update = useCliVersionsStore((s) => s.update);
  const busy = useCliVersionsLive();

  const onUpdate = async (cli: AgentCli) => {
    const refused = await update(cli);
    if (refused) showToast(refused, 'error');
  };

  const checkedAt = items?.[0]?.checkedAt;
  return (
    <div className={styles.section}>
      <h4>Agent CLIs</h4>
      <p className={styles.settingsHint}>
        The Claude Code and Codex this Mac’s terminals start. Update runs the CLI’s own updater on the Mac; sessions
        already running keep their version until you restart them.
      </p>
      {error && <p className={styles.cliError} role="alert">{error}</p>}
      {!items && loading && <p className={styles.settingsHint}>Reading versions…</p>}
      {items && (
        <ul className={styles.cliList}>
          {items.map((info) => {
            const view = describeCli(info, busy);
            return (
              <li key={info.cli} className={styles.cliRow}>
                <span className={`${styles.cliDot} ${TONE_CLASS[view.tone]}`} aria-hidden="true" />
                <span className={styles.cliText}>
                  <span className={styles.cliName}>{view.name}</span>
                  <span className={styles.cliStatus} aria-live="polite">{view.status}</span>
                </span>
                <button
                  type="button"
                  className={styles.fontBtn}
                  disabled={!!view.disabledReason}
                  title={view.disabledReason}
                  aria-label={`Update ${view.name}`}
                  onClick={() => void onUpdate(info.cli)}
                >
                  {view.buttonLabel}
                </button>
                {/* One per run: a log hidden last time still opens by itself on the next failure. */}
                <CliUpdateLog key={info.update.startedAt ?? 'none'} info={info} name={view.name} />
              </li>
            );
          })}
        </ul>
      )}
      <div className={styles.cliFooter}>
        <button
          type="button"
          className={styles.fontBtn}
          disabled={loading || busy !== null}
          title={busy ? 'Wait for the update to finish.' : undefined}
          onClick={() => void load(true)}
        >
          {loading ? 'Checking…' : 'Check again'}
        </button>
        {checkedAt !== undefined && <span className={styles.settingsHint}>Checked at {checkedLabel(checkedAt)}</span>}
      </div>
    </div>
  );
}
