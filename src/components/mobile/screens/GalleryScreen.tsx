/**
 * GalleryScreen — More → About → UI kit (AASC-38): every phone kit component in
 * every state, for the acceptance check and for whoever builds the next screen.
 * Phone-only and harmless: nothing here talks to the Mac.
 */
import { useCallback, useState, type ReactNode } from 'react';
import {
  Banner,
  Button,
  Chip,
  ConfirmSheet,
  ContextMenu,
  EmptyState,
  ListRow,
  ListSection,
  Screen,
  SegmentedControl,
  Sheet,
  StatusRing,
  SwipeRow,
} from '../kit';
import { InboxTabIcon } from '../kit/kitIcons';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/mobile/Gallery.module.css';

const STATUSES = ['approval', 'input', 'working', 'prompting', 'waiting', 'idle', 'connecting', 'ended'] as const;

const SEGMENTS = [
  { value: 'chat', label: 'Chat' },
  { value: 'changes', label: 'Changes', badge: '+42' },
  { value: 'terminal', label: 'Terminal' },
] as const;

const SEGMENTS_DISABLED = [
  { value: 'chat', label: 'Chat', disabledReason: 'This session has no transcript' },
  { value: 'changes', label: 'Changes' },
  { value: 'terminal', label: 'Terminal' },
] as const;

const FILTERS = ['All', 'Needs you', 'Working', 'Idle'] as const;

type Segment = (typeof SEGMENTS)[number]['value'];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.group} aria-label={title}>
      <h2 className={styles.groupTitle}>{title}</h2>
      {children}
    </section>
  );
}

export default function GalleryScreen() {
  const pop = usePhoneNavStore((s) => s.pop);
  const [segment, setSegment] = useState<Segment>('chat');
  const [segment2, setSegment2] = useState<Segment>('changes');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');
  const [toggle, setToggle] = useState(true);
  const [loading, setLoading] = useState(false);
  const [sheet, setSheet] = useState<'medium' | 'large' | 'fit' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastAction, setLastAction] = useState('Nothing yet');

  const closeSheet = useCallback(() => setSheet(null), []);
  const cancelConfirm = useCallback(() => setConfirming(false), []);
  const say = (what: string) => () => setLastAction(what);

  const startLoading = () => {
    setLoading(true);
    setTimeout(() => setLoading(false), 1500);
  };
  const confirm = () => {
    setBusy(true);
    setTimeout(() => {
      setBusy(false);
      setConfirming(false);
      showToast('Session killed (sample)', 'success');
    }, 900);
  };

  const rowActions = [
    { id: 'mute', label: 'Mute', onAction: say('Muted (swipe)') },
    { id: 'delete', label: 'Delete', tone: 'destructive' as const, onAction: say('Deleted (swipe)') },
  ];
  const menuItems = [
    { id: 'rename', label: 'Rename', onSelect: say('Rename (menu)') },
    { id: 'mute', label: 'Mute', onSelect: say('Muted (menu)') },
    { id: 'pin', label: 'Pin', disabledReason: 'Only your Mac can pin', onSelect: say('Pin') },
    { id: 'delete', label: 'Delete', destructive: true, onSelect: say('Deleted (menu)') },
  ];

  return (
    <Screen title="UI kit" subtitle="Phone components and states" onBack={pop} backLabel="Back to About" testId="phone-gallery">
      <p className={styles.intro}>Last action: <strong>{lastAction}</strong></p>

      <Group title="Buttons">
        <div className={styles.stack}>
          <Button variant="primary" onClick={say('Primary')}>Primary</Button>
          <Button variant="secondary" onClick={say('Secondary')}>Secondary</Button>
          <Button variant="plain" onClick={say('Plain')}>Plain</Button>
          <Button variant="destructive" onClick={say('Destructive')}>Destructive</Button>
          <Button variant="primary" loading={loading} loadingLabel="Sending…" onClick={startLoading}>
            {loading ? 'Sending…' : 'Tap to load'}
          </Button>
          <Button variant="primary" block disabledReason="Your Mac is driving this session">Send</Button>
          <div className={styles.row}>
            <Button small onClick={say('Small')}>Small</Button>
            <Button small variant="plain" onClick={say('Small plain')}>Small plain</Button>
          </div>
        </div>
      </Group>

      <Group title="Segmented control">
        <div className={styles.stack}>
          <SegmentedControl segments={SEGMENTS} value={segment} onChange={setSegment} label="Sample view" />
          <SegmentedControl segments={SEGMENTS_DISABLED} value={segment2} onChange={setSegment2} label="Sample view with a disabled segment" />
        </div>
      </Group>

      <Group title="Chips">
        <div className={styles.chips}>
          {FILTERS.map((f) => (
            <Chip key={f} label={f} selected={filter === f} count={f === 'Needs you' ? 3 : undefined} onClick={() => setFilter(f)} />
          ))}
          <Chip label="Rooms" disabledReason="Rooms arrive with the Sessions tab" onClick={say('Rooms')} />
          <Chip label="Read-only label" />
        </div>
      </Group>

      <Group title="Status rings">
        <ul className={styles.rings}>
          {STATUSES.map((s) => (
            <li key={s}><StatusRing status={s} withLabel /></li>
          ))}
          <li><StatusRing status="waiting" interrupted withLabel /></li>
          <li><StatusRing status="working" size="small" withLabel /></li>
        </ul>
      </Group>

      <Group title="Banners">
        <Banner tone="info" title="Your Mac sends queued prompts">AASC is open on the Mac.</Banner>
        <Banner tone="success" title="Prompt sent" />
        <Banner tone="warning" title="Open AASC on your Mac" action={{ label: 'Retry', onClick: say('Retry') }}>
          Queued prompts wait until it is.
        </Banner>
        <Banner tone="error" title="The Mac refused that">This phone may not pin sessions.</Banner>
        <Banner tone="offline" title="Reconnecting to your Mac…">What you see is from the last update.</Banner>
      </Group>

      <ListSection header="List rows" footer="Rows push (›), toggle, show a value, or explain why they're off.">
        <ListRow title="Plain row" />
        <ListRow title="With a value" value="Opus 5.5 · high" />
        <ListRow title="Pushes a screen" subtitle="With a subtitle line" chevron onClick={say('Row')} />
        <ListRow leading={<StatusRing status="approval" />} tall title="agent-manager-2" subtitle="Wants to run: npm run build" chevron onClick={say('Session row')} />
        <ListRow title="Notifications" toggle={{ checked: toggle, onChange: setToggle }} />
        <ListRow title="Unpair this phone" disabledReason="Only from the Mac while it is offline" onClick={say('Unpair')} />
        <ListRow title="Kill session" destructive onClick={() => setConfirming(true)} />
      </ListSection>

      <Group title="Swipe and long press">
        <p className={styles.hint}>Swipe the row left for its actions, or hold it for the same ones in a menu.</p>
        <div className={styles.swipeList}>
          <SwipeRow actions={rowActions}>
            <ContextMenu items={menuItems} label="Actions for exmouth-erp-1">
              <ul className={styles.bare} role="list">
                <ListRow title="exmouth-erp-1" subtitle="Hold me, or swipe me" leading={<StatusRing status="input" />} tall onClick={say('Opened (tap)')} />
              </ul>
            </ContextMenu>
          </SwipeRow>
        </div>
      </Group>

      <Group title="Sheets">
        <div className={styles.stack}>
          <Button onClick={() => setSheet('fit')}>Fit-to-content sheet</Button>
          <Button onClick={() => setSheet('medium')}>Medium sheet</Button>
          <Button onClick={() => setSheet('large')}>Large sheet</Button>
          <Button variant="destructive" onClick={() => setConfirming(true)}>Confirm sheet</Button>
          <Button variant="plain" onClick={() => showToast('A toast above the tab bar', 'info')}>Show a toast</Button>
        </div>
      </Group>

      <Group title="Empty state">
        <div className={styles.card}>
          <EmptyState
            icon={<InboxTabIcon />}
            title="Nothing needs you"
            message="Approvals, questions and turns that stopped show up here."
            action={<Button variant="secondary" onClick={say('Empty action')}>Refresh</Button>}
          />
        </div>
      </Group>

      <Sheet
        open={sheet !== null}
        onClose={closeSheet}
        title={sheet === 'large' ? 'Large sheet' : sheet === 'medium' ? 'Medium sheet' : 'Sheet'}
        detents={sheet === 'fit' ? ['fit'] : ['medium', 'large']}
        initialDetent={sheet === 'large' ? 'large' : undefined}
        footer={<Button variant="primary" block onClick={closeSheet}>Done</Button>}
        testId="gallery-sheet"
      >
        <p className={styles.hint}>Drag the grabber up to grow, down to shrink or close. Escape, the × and a tap outside close it too.</p>
        <ListSection label="Sample choices">
          <ListRow title="Claude" chevron onClick={closeSheet} />
          <ListRow title="Codex" chevron onClick={closeSheet} />
        </ListSection>
      </Sheet>

      <ConfirmSheet
        open={confirming}
        title="Kill agent-manager-2?"
        message="The agent stops (SIGTERM, then SIGKILL) and the session ends on every device."
        confirmLabel="Kill"
        danger
        busy={busy}
        onConfirm={confirm}
        onCancel={cancelConfirm}
      />
    </Screen>
  );
}
