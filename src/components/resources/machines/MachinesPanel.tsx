/**
 * MachinesPanel — RESOURCES › Machines (Nov 13 2026): the computers this Mac reaches, starting with
 * This Mac itself — its Tailscale address and how paired phones find it away from home (the old
 * Connection › Remote access, which needs no cloud connection). Scanning the network and saving
 * SSH machines come next, in this same tab.
 *
 * Lazy-loaded by ResourcesView and kept mounted (hidden) once opened, so Remote access reads
 * Tailscale once per visit rather than on every tab switch.
 */
import SectionHeader from '@/components/ui/SectionHeader';
import CloudRemoteAccess from '@/components/resources/cloud/CloudRemoteAccess';
import lib from '@/styles/modules/ResourceLibrary.module.css';

export default function MachinesPanel({
  open,
  onAccount,
}: {
  /** Machines is the open RESOURCES tab. */
  open: boolean;
  /** Open the cloud account dialog (Remote access's "Open cloud account"). */
  onAccount: () => void;
}) {
  return (
    <div className={lib.connection}>
      <section aria-label="This Mac">
        <SectionHeader label="This Mac" level={2} />
        <CloudRemoteAccess visible={open} onConnection={onAccount} />
      </section>
    </div>
  );
}
