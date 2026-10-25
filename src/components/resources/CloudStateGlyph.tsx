/**
 * CloudStateGlyph — a Library row's cloud state as one small mark (Oct 23 2026). Rows already carry
 * three to five word chips (agent, scope, repo, ≠ variant), so the state is a glyph, not another
 * word: a distinct shape per state (never colour alone), with the words as its accessible name and
 * tooltip. Nothing renders for a resource that does not sync.
 */
import type { SyncState } from '@/types/cloudResources';
import { SYNC_STATE_INFO } from '@/lib/cloudSyncStates';
import styles from '@/styles/modules/CloudSync.module.css';

const PATH_PROPS = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
/** The cloud outline every glyph but the arrows sits in. */
const CLOUD = 'M4.6 11.2h5.9a2.6 2.6 0 0 0 .3-5.2 3.4 3.4 0 0 0-6.4-.6A2.9 2.9 0 0 0 4.6 11.2z';

function Shape({ state }: { state: SyncState | 'moving' }) {
  switch (state) {
    case 'synced':
      return (
        <>
          <path d={CLOUD} {...PATH_PROPS} />
          <polyline points="5.6,8.4 7,9.7 9.4,7.2" {...PATH_PROPS} />
        </>
      );
    case 'local-changed':
      return (
        <>
          <line x1="7.5" y1="12" x2="7.5" y2="3.4" {...PATH_PROPS} />
          <polyline points="4.4,6.4 7.5,3.3 10.6,6.4" {...PATH_PROPS} />
        </>
      );
    case 'cloud-newer':
    case 'cloud-only':
      return (
        <>
          <line x1="7.5" y1="3" x2="7.5" y2="11.6" {...PATH_PROPS} />
          <polyline points="4.4,8.6 7.5,11.7 10.6,8.6" {...PATH_PROPS} />
        </>
      );
    case 'conflict':
      return (
        <>
          <line x1="5" y1="12" x2="5" y2="3.4" {...PATH_PROPS} />
          <polyline points="2.8,5.6 5,3.3 7.2,5.6" {...PATH_PROPS} />
          <line x1="10" y1="3" x2="10" y2="11.6" {...PATH_PROPS} />
          <polyline points="7.8,9.4 10,11.7 12.2,9.4" {...PATH_PROPS} />
        </>
      );
    case 'blocked':
      return (
        <>
          <circle cx="7.5" cy="7.5" r="4.6" {...PATH_PROPS} />
          <line x1="4.3" y1="10.7" x2="10.7" y2="4.3" {...PATH_PROPS} />
        </>
      );
    case 'stopped':
      return (
        <>
          <path d={CLOUD} {...PATH_PROPS} />
          <line x1="6.5" y1="7.2" x2="6.5" y2="9.6" {...PATH_PROPS} />
          <line x1="8.6" y1="7.2" x2="8.6" y2="9.6" {...PATH_PROPS} />
        </>
      );
    case 'removed':
      return (
        <>
          <path d={CLOUD} {...PATH_PROPS} />
          <line x1="6" y1="7.1" x2="9" y2="10" {...PATH_PROPS} />
          <line x1="9" y1="7.1" x2="6" y2="10" {...PATH_PROPS} />
        </>
      );
    case 'moving':
    default:
      return <path d="M12 7.5a4.5 4.5 0 1 1-1.5-3.4" {...PATH_PROPS} />;
  }
}

export default function CloudStateGlyph({
  state,
  moving = false,
}: {
  state: SyncState;
  moving?: boolean;
}) {
  const info = SYNC_STATE_INFO[state];
  const label = moving ? 'Syncing now' : `Cloud: ${info.label}`;
  return (
    <span
      className={styles.glyph}
      data-tone={moving ? 'info' : info.tone}
      data-moving={moving ? '' : undefined}
      role="img"
      aria-label={label}
      title={label}
    >
      <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
        <Shape state={moving ? 'moving' : state} />
      </svg>
    </span>
  );
}
