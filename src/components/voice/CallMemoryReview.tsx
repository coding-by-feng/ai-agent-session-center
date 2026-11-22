/**
 * CallMemoryReview — what AASC could keep from voice calls, and what it keeps (Nov 22 2026; server/voice/callMemory.ts).
 *
 * A call proposes preferences, corrections of misheard words and habits; none is used until it is kept here.
 * Each proposal shows what was heard, a scope (everywhere, or one project) and Keep · Edit · Skip. A kept item can be
 * forgotten. Shown in Settings → ADVANCED → Voice calls on the Mac and from the phone's Sessions banner; the server
 * shows a phone only items of projects it can see.
 */
import { useCallback, useEffect, useState } from 'react';
import Button from '@/components/ui/Button';
import IconButton from '@/components/ui/IconButton';
import NativeSelect from '@/components/ui/NativeSelect';
import TextArea from '@/components/ui/TextArea';
import TrashIcon from '@/components/ui/TrashIcon';
import { showToast } from '@/components/ui/ToastContainer';
import {
  KIND_LABELS, decideCallMemory, fetchCallMemory, scopeLabel, type CallMemoryDecision, type CallMemoryItem, type CallMemoryList,
} from '@/lib/callMemoryClient';
import styles from '@/styles/modules/CallMemory.module.css';

interface Props {
  /** Called with the number of proposals left after each change (the phone banner's count). */
  onPendingChange?: (pending: number) => void;
}

const pendingOf = (list: CallMemoryList | null): number => list?.items.filter((i) => i.status === 'proposed').length ?? 0;

function ProposalRow({ item, projects, onDecide }: { item: CallMemoryItem; projects: string[]; onDecide: (d: CallMemoryDecision) => Promise<void> }) {
  const [scope, setScope] = useState(item.scope);
  const [editing, setEditing] = useState(false);
  const [meant, setMeant] = useState(item.meant);
  const [busy, setBusy] = useState(false);
  const scopes = [...new Set(['global', ...projects.map((p) => `project:${p}`), item.scope])];
  const decide = async (d: CallMemoryDecision) => {
    setBusy(true);
    try { await onDecide(d); } finally { setBusy(false); }
  };
  const keep = () => {
    const edited = meant.trim();
    void decide({ action: 'keep', scope, ...(edited && edited !== item.meant ? { meant: edited } : {}) });
  };
  return (
    <li className={styles.row} aria-label={item.meant}>
      <div className={styles.head}>
        <span className={styles.kind}>{KIND_LABELS[item.kind]}</span>
        {editing ? (
          <TextArea aria-label="What you meant" className={styles.edit} value={meant} rows={2} maxLength={240} onChange={(e) => setMeant(e.target.value)} />
        ) : (
          <span className={styles.meant}>{item.kind === 'correction' ? `“${item.heard}” means ${item.meant}` : item.meant}</span>
        )}
      </div>
      {item.kind !== 'correction' && <span className={styles.heard}>heard “{item.heard}”</span>}
      <div className={styles.actions}>
        <label className={styles.scope}>
          <span className={styles.scopeLabel}>Use for</span>
          <NativeSelect aria-label="Use for" value={scope} onChange={setScope} disabled={busy}
            options={scopes.map((s) => ({ value: s, label: scopeLabel(s) }))} />
        </label>
        <Button variant="primary" disabled={busy || !meant.trim()} onClick={keep}>Keep</Button>
        <IconButton label="Edit" ariaLabel={`Edit “${item.meant}”`} pressed={editing} disabled={busy} onClick={() => setEditing((v) => !v)}>✎</IconButton>
        <IconButton label="Skip" ariaLabel={`Skip “${item.meant}”`} disabled={busy} onClick={() => void decide({ action: 'skip' })}>✕</IconButton>
      </div>
    </li>
  );
}

function KeptRow({ item, onDecide }: { item: CallMemoryItem; onDecide: (d: CallMemoryDecision) => Promise<void> }) {
  return (
    <li className={styles.row} aria-label={item.meant}>
      <div className={styles.head}>
        <span className={styles.kind}>{KIND_LABELS[item.kind]}</span>
        <span className={styles.meant}>{item.kind === 'correction' ? `“${item.heard}” means ${item.meant}` : item.meant}</span>
      </div>
      <div className={styles.actions}>
        <span className={styles.heard}>{scopeLabel(item.scope)}</span>
        <IconButton label="Forget" ariaLabel={`Forget “${item.meant}”`} tone="danger" className={styles.forget}
          onClick={() => void onDecide({ action: 'retire' })}><TrashIcon /></IconButton>
      </div>
    </li>
  );
}

export default function CallMemoryReview({ onPendingChange }: Props) {
  const [list, setList] = useState<CallMemoryList | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchCallMemory()
      .then((data) => { if (!cancelled) { setList(data); setFailed(data === null); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { onPendingChange?.(pendingOf(list)); }, [list, onPendingChange]);

  const decide = useCallback(async (id: string, d: CallMemoryDecision) => {
    try {
      const updated = await decideCallMemory(id, d);
      setList((l) => (l ? { ...l, items: l.items.map((i) => (i.id === id ? updated : i)) } : l));
      if (d.action === 'keep') showToast('Kept: AASC will use it in calls', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not save that', 'error');
    }
  }, []);

  if (failed) return <p className={styles.empty}>Couldn’t load call memory.</p>;
  if (!list) return null;
  const proposed = list.items.filter((i) => i.status === 'proposed');
  const kept = list.items.filter((i) => i.status === 'kept');

  return (
    <div className={styles.wrap}>
      {proposed.length > 0 && (
        <section aria-label="From your calls">
          <h5 className={styles.title}>From your calls · {proposed.length} to review</h5>
          <ul className={styles.list}>
            {proposed.map((i) => <ProposalRow key={i.id} item={i} projects={list.projects} onDecide={(d) => decide(i.id, d)} />)}
          </ul>
        </section>
      )}
      <section aria-label="Kept">
        <h5 className={styles.title}>Kept</h5>
        {kept.length === 0
          ? <p className={styles.empty}>Nothing kept from calls yet.</p>
          : <ul className={styles.list}>{kept.map((i) => <KeptRow key={i.id} item={i} onDecide={(d) => decide(i.id, d)} />)}</ul>}
      </section>
    </div>
  );
}
