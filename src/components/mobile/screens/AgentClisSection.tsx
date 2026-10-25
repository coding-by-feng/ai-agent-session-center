/**
 * More → Settings → Advanced → Your Mac’s agent CLIs (Oct 25 2026): the Claude Code and Codex the
 * Mac's terminals start, and their update. Tapping a CLI that has an update asks first, then runs
 * the CLI's own updater on the Mac; the Mac lets one phone do that once per CLI per 10 minutes.
 */
import { useCallback, useState } from 'react';
import { ConfirmSheet, ListRow, ListSection } from '../kit';
import { useCliVersionsStore } from '@/stores/cliVersionsStore';
import { useCliVersionsLive } from '@/hooks/useCliVersionsLive';
import { describeCli, CLI_NAMES } from '@/lib/cliVersionsView';
import { showToast } from '@/components/ui/ToastContainer';
import type { AgentCli } from '@/types/cliVersions';

export default function AgentClisSection() {
  const items = useCliVersionsStore((s) => s.items);
  const loading = useCliVersionsStore((s) => s.loading);
  const error = useCliVersionsStore((s) => s.error);
  const load = useCliVersionsStore((s) => s.load);
  const update = useCliVersionsStore((s) => s.update);
  const busy = useCliVersionsLive();
  const [confirming, setConfirming] = useState<AgentCli | null>(null);
  const cancel = useCallback(() => setConfirming(null), []);

  const confirm = async () => {
    const cli = confirming;
    setConfirming(null);
    if (!cli) return;
    const refused = await update(cli);
    if (refused) showToast(refused, 'error');
  };

  return (
    <>
      <ListSection
        header="Your Mac’s agent CLIs"
        footer="Update runs the CLI’s own updater on your Mac. Sessions already running keep their version until you restart them."
      >
        {!items && (
          <ListRow title={loading ? 'Reading versions…' : 'Couldn’t read the versions'} subtitle={error ?? undefined} />
        )}
        {items?.map((info) => {
          const view = describeCli(info, busy);
          const canUpdate = !view.disabledReason;
          return (
            <ListRow
              key={info.cli}
              title={view.name}
              subtitle={view.status}
              value={info.update.state === 'updating' ? 'Updating…' : canUpdate ? 'Update' : undefined}
              onClick={canUpdate ? () => setConfirming(info.cli) : undefined}
              ariaLabel={canUpdate ? `Update ${view.name}: ${view.status}` : undefined}
              testId={`phone-cli-${info.cli}`}
            />
          );
        })}
        <ListRow
          title={loading ? 'Checking…' : 'Check again'}
          onClick={() => void load(true)}
          disabledReason={loading ? 'Checking for newer versions…' : busy ? 'Wait for the update to finish.' : undefined}
        />
      </ListSection>
      <ConfirmSheet
        open={confirming !== null}
        title={confirming ? `Update ${CLI_NAMES[confirming]} on your Mac?` : ''}
        message={confirming ? `Your Mac runs “${confirming} update”. Sessions already running keep their version until you restart them.` : ''}
        confirmLabel="Update"
        onConfirm={() => void confirm()}
        onCancel={cancel}
      />
    </>
  );
}
