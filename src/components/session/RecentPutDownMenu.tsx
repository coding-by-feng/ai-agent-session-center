/**
 * RecentPutDownMenu — RECENT's header chip for the sessions put down today (Nov 23 2026): eye-off + N, and a menu that
 * puts each back (or all). Shown only while one is put down. The shared Menu owns the placement (portaled, clamped
 * inside the viewport), the keyboard and outside clicks. Put down itself is the eye-off on each RECENT card.
 */
import Menu, { type MenuSection } from '@/components/ui/Menu';
import Tooltip from '@/components/ui/Tooltip';
import { useRecentPutDownStore } from '@/stores/recentPutDownStore';
import type { Session } from '@/types';
import { PutDownIcon } from './SessionFrameIcons';
import styles from '@/styles/modules/DetailPanel.module.css';

export default function RecentPutDownMenu({ sessions }: { sessions: readonly Session[] }) {
  const putBack = useRecentPutDownStore((s) => s.putBackSession);
  const putBackAll = useRecentPutDownStore((s) => s.putBackAll);
  if (sessions.length === 0) return null;
  const count = sessions.length;
  const sections: MenuSection[] = [
    {
      id: 'put-back',
      title: 'Put back in Recent',
      items: sessions.map((s) => ({
        kind: 'action' as const,
        id: s.sessionId,
        label: s.title || s.projectName || '(untitled)',
        hint: 'Show it in Recent again',
        onSelect: () => putBack(s.sessionId),
      })),
    },
    ...(count > 1
      ? [{ id: 'all', items: [{ kind: 'action' as const, id: 'all', label: 'Put all back', onSelect: putBackAll }] }]
      : []),
  ];
  const name = `${count} put down from Recent today`;
  // The shared Tooltip (Nov 24 2026), so the hint shows on keyboard focus too; opening the menu moves focus into
  // it, which closes the hint, as for every icon-button menu.
  return (
    <Tooltip label={name} description="Click to put them back in Recent." placement="bottom">
      <Menu
        label="Put back in Recent"
        triggerLabel={name}
        sections={sections}
        plainTrigger={{
          className: styles.recentPutDownChip,
          content: (
            <>
              <PutDownIcon />
              <span>{count}</span>
            </>
          ),
        }}
      />
    </Tooltip>
  );
}
