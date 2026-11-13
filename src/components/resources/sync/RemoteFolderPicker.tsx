/**
 * RemoteFolderPicker — one level of a folder on a saved server, inside its home (Nov 13 2026).
 * `folder` picks the folder you are in (a link's server folder); `items` ticks folders and files
 * to pull. Credential folders never show; links are listed but not followed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteListing, SyncDevice } from '@/types/projectSync';
import { projectSyncApi } from '@/lib/projectSyncApi';
import { formatBytes } from '@/lib/projectSyncFormat';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import styles from '@/styles/modules/ProjectSync.module.css';

type Props = {
  device: SyncDevice;
  /** Where to open (default: the server's home). */
  start?: string;
} & (
  | { mode: 'folder'; onUse: (path: string) => void; onCancel: () => void }
  | { mode: 'items'; selected: string[]; onSelected: (paths: string[]) => void }
);

export default function RemoteFolderPicker(props: Props) {
  const { device } = props;
  // Where it opened: typing in the field behind the picker does not move it.
  const [start] = useState(props.start);
  const [path, setPath] = useState<string | undefined>(start);
  const [listing, setListing] = useState<RemoteListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the latest request shows: quick clicks must not land on an older folder.
  const latest = useRef(0);

  const open = useCallback(
    (to: string | undefined, fallbackHome = false) => {
      const ticket = ++latest.current;
      const read = projectSyncApi.browse(device.id, to);
      (fallbackHome ? read.catch(() => projectSyncApi.browse(device.id)) : read)
        .then((l) => {
          if (ticket !== latest.current) return;
          setError(null);
          setListing(l);
          setPath(l.path);
        })
        .catch((e: unknown) => {
          if (ticket === latest.current)
            setError(e instanceof Error ? e.message : 'Could not read the server folder.');
        });
    },
    [device.id],
  );
  // The first listing: the starting folder, or home when it is gone. A newer request (another
  // server, a click) outdates it through `latest`.
  useEffect(() => {
    open(start, true);
  }, [open, start]);

  const selected = props.mode === 'items' ? props.selected : [];
  const toggle = (p: string) => {
    if (props.mode !== 'items') return;
    props.onSelected(selected.includes(p) ? selected.filter((x) => x !== p) : [...selected, p]);
  };
  const atHome = !listing || listing.parent === null;

  return (
    <div className={styles.picker} role="group" aria-label={`Folders on ${device.name}`}>
      <div className={styles.pickerHead}>
        <Button
          size="sm"
          variant="quiet"
          disabled={atHome}
          onClick={() => open(listing?.parent ?? undefined)}
        >
          Up
        </Button>
        <span className={styles.mono}>{path ?? device.home}</span>
      </div>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : !listing ? (
        <EmptyState compact busy title="Reading the server folder…" />
      ) : !listing.entries.length ? (
        <EmptyState compact title="This folder is empty." />
      ) : (
        <ul className={styles.pickerList}>
          {listing.entries.map((e) => (
            <li key={e.path} className={styles.pickerRow}>
              {props.mode === 'items' && (e.kind === 'dir' || e.kind === 'file') ? (
                <label className={styles.pickerCheck}>
                  <input
                    type="checkbox"
                    checked={selected.includes(e.path)}
                    onChange={() => toggle(e.path)}
                  />
                  <span>{e.name}</span>
                </label>
              ) : (
                <span className={styles.pickerName}>{e.name}</span>
              )}
              {e.kind === 'dir' ? (
                <Button
                  size="sm"
                  variant="quiet"
                  aria-label={`Open ${e.name}`}
                  onClick={() => open(e.path)}
                >
                  Open
                </Button>
              ) : (
                <span className={styles.hint}>
                  {e.kind === 'file' ? formatBytes(e.size) : e.kind === 'link' ? 'link' : 'special'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {listing?.truncated ? (
        <p className={styles.hint}>Only the first 2,000 entries are listed.</p>
      ) : null}
      {props.mode === 'folder' ? (
        <div className={styles.formActions}>
          <Button
            variant="primary"
            disabled={atHome || !!error}
            onClick={() => path && props.onUse(path)}
          >
            Use this folder
          </Button>
          <Button variant="quiet" onClick={props.onCancel}>
            Cancel
          </Button>
        </div>
      ) : selected.length ? (
        <p className={styles.hint}>
          {selected.length} selected: {selected.map((p) => p.split('/').pop()).join(', ')}
        </p>
      ) : null}
    </div>
  );
}
