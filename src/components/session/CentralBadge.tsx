/**
 * CentralBadge — the ★ mark a session card carries when the session is a central (server/mcp): an agent
 * that reads, and later drives, other sessions through AASC's MCP server.
 *
 *   ★ global · ★ room Backend · ★ project agent-manager
 *
 * It reads the card's own marker (`Session.central`), so it needs no list from the server; a room's name
 * comes from the room store (plain `★ room` when that room is gone). With the server's list it also counts the
 * sessions the central opened itself and still runs (P4): `★ global · 3 workers`; nothing when it runs none. Hovering it gives the full scope in
 * the shared Tooltip, which the badge may have cut short (a folder shows as its name, a long name is
 * ellipsised).
 *
 * It is a mark, not a control: no button, no tab stop. It sits inside the rail's cards, which are buttons,
 * and a focusable thing inside a button is two controls in one. The words are the accessible name; with
 * `compact` (the star alone, for a card with no room for words) the name is spelled out instead.
 */
import Tooltip from '@/components/ui/Tooltip';
import { useMcpStore } from '@/stores/mcpStore';
import { useRoomStore } from '@/stores/roomStore';
import { centralBadgeText, centralLabel, centralTooltip, workersText } from '@/lib/centralChoice';
import type { SessionCentralMarker } from '@/types';
import styles from '@/styles/modules/CentralBadge.module.css';

interface CentralBadgeProps {
  central: SessionCentralMarker;
  /** The star alone, with the scope in its accessible name and its tooltip. */
  compact?: boolean;
  /** For the card or header the badge sits in (its place in that layout). */
  className?: string;
}

export default function CentralBadge({ central, compact = false, className }: CentralBadgeProps) {
  // A string or undefined: the badge re-renders when its room is renamed, and not when any other changes.
  const roomName = useRoomStore((s) =>
    central.kind === 'room' ? s.rooms.find((r) => r.id === central.scopeRef)?.name : undefined,
  );
  const workers = workersText(useMcpStore((s) => s.centrals.get(central.centralId)?.workerCount ?? 0));
  const text = centralBadgeText(central, roomName);
  const label = centralLabel(central, roomName);
  return (
    <span className={className ? `${styles.root} ${className}` : styles.root}>
      <Tooltip label="Central session" description={centralTooltip(central, roomName)} placement="bottom">
        {compact ? (
          <span
            className={`${styles.badge} ${styles.compact}`}
            role="img"
            aria-label={workers ? `${label}, ${workers}` : label}
          >
            ★
          </span>
        ) : (
          <span className={styles.badge}>{workers ? `${text} · ${workers}` : text}</span>
        )}
      </Tooltip>
    </span>
  );
}
