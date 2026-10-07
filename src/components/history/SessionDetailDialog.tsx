/**
 * SessionDetailDialog — the HISTORY tab's per-session detail: a status chip and
 * the facts line over Conversation / Activity tabs, in the shared `Modal`.
 *
 * It opens at once, named from the row it was opened from, and loads the
 * detail itself (loading, then the body, or an error with Retry — no Retry on
 * a 403/404, where asking again changes nothing). `Modal` is not portaled on
 * its own, so the dialog is (like `UninstallDialog`).
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { authFetch } from '@/hooks/useAuth';
import { canRetry, readJson } from '@/lib/requestJson';
import { formatClock, plural, sessionDuration, sessionName, statusChip } from '@/lib/historyFormat';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import IconButton from '@/components/ui/IconButton';
import Modal from '@/components/ui/Modal';
import Tabs from '@/components/ui/Tabs';
import { showToast } from '@/components/ui/ToastContainer';
import type { DbSessionRow, SessionDetailResponse } from '@/types';
import styles from '@/styles/modules/History.module.css';

/** How long a copy button says "Copied" before it reverts. */
const COPIED_MS = 1500;

function Icon({ children, strokeWidth = 2 }: { children: ReactNode; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const CopyIcon = () => (
  <Icon>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Icon>
);

const CheckIcon = () => (
  <Icon strokeWidth={2.5}>
    <polyline points="20 6 9 17 4 12" />
  </Icon>
);

interface SessionDetailDialogProps {
  /** The `uiStore` modal id the view opened. */
  modalId: string;
  sessionId: string;
  /** The row this was opened from — names the dialog before the detail loads. */
  listed: DbSessionRow | undefined;
  onClose: () => void;
}

export default function SessionDetailDialog({ modalId, sessionId, listed, onClose }: SessionDetailDialogProps) {
  const { data: detail, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['db-session-detail', sessionId],
    queryFn: async () =>
      readJson<SessionDetailResponse>(
        await authFetch(`/api/db/sessions/${encodeURIComponent(sessionId)}`),
        'Failed to load session detail',
      ),
  });

  const named = detail?.session ?? listed;
  const renderBody = (): ReactNode => {
    if (detail) return <SessionDetailBody detail={detail} now={dataUpdatedAt} />;
    if (isError) {
      return (
        <EmptyState
          tone="error"
          compact
          className={styles.detailState}
          title="Could not load this session"
          hint={error?.message}
          action={canRetry(error) ? <Button onClick={() => refetch()}>Retry</Button> : undefined}
        />
      );
    }
    return <EmptyState busy compact className={styles.detailState} title="Loading session…" />;
  };

  return createPortal(
    <Modal
      modalId={modalId}
      title={named ? sessionName(named) : sessionId}
      onClose={onClose}
      panelClassName={styles.detailPanel}
    >
      {renderBody()}
    </Modal>,
    document.body,
  );
}

function SessionDetailBody({ detail, now }: { detail: SessionDetailResponse; now: number }) {
  const [activeTab, setActiveTab] = useState('conversation');
  // Each Copy button is described by its entry's role and time ("Copy message,
  // Prompt 14:02"), so a screen-reader list of buttons is not N identical names.
  const idBase = useId();
  const { session: sess, prompts, responses, tool_calls, events } = detail;

  // Interleaved conversation
  const convoEntries = useMemo(
    () =>
      [
        ...prompts.map((p) => ({ key: `p-${p.id}`, type: 'prompt' as const, timestamp: p.timestamp, text: p.text })),
        ...responses.map((r) => ({
          key: `r-${r.id}`,
          type: 'response' as const,
          timestamp: r.timestamp,
          text: r.text_excerpt,
        })),
      ].sort((a, b) => a.timestamp - b.timestamp),
    [prompts, responses],
  );

  // Merged activity
  const activityEntries = useMemo(
    () =>
      [
        ...tool_calls.map((t) => ({
          key: `t-${t.id}`,
          kind: 'tool' as const,
          label: t.tool_name,
          detail: t.tool_input_summary,
          timestamp: t.timestamp,
        })),
        ...events.map((e) => ({
          key: `e-${e.id}`,
          kind: 'event' as const,
          label: e.event_type,
          detail: e.detail,
          timestamp: e.timestamp,
        })),
      ].sort((a, b) => b.timestamp - a.timestamp),
    [tool_calls, events],
  );

  const chip = statusChip(sess);
  const duration = sessionDuration(sess, now);
  // The dialog is titled with the session's name; the project joins the facts
  // unless the name already is the project.
  const facts = [
    sess.title && sess.project_name ? sess.project_name : '',
    sess.model,
    duration === '--' ? '' : duration,
    plural(sess.total_prompts, 'prompt'),
    plural(sess.total_tool_calls, 'tool'),
  ]
    .filter(Boolean)
    .join(' · ');

  const tabs = [
    {
      id: 'conversation',
      label: `Conversation (${convoEntries.length})`,
      content:
        convoEntries.length === 0 ? (
          <EmptyState compact className={styles.detailState} title="No conversation recorded" />
        ) : (
          <ul className={styles.detailBody} role="list">
            {convoEntries.map((entry) => (
              <li
                key={entry.key}
                className={`${styles.convoEntry} ${
                  entry.type === 'prompt' ? styles.convoPrompt : styles.convoResponse
                }`}
              >
                <div className={styles.convoEntryHeader}>
                  <span className={styles.convoMeta} id={`${idBase}-${entry.key}`}>
                    <span className={styles.convoRole}>
                      {entry.type === 'prompt' ? 'Prompt' : 'Response'}
                    </span>
                    <span className={styles.convoTime}>{formatClock(entry.timestamp, false)}</span>
                  </span>
                  <CopyButton text={entry.text} describedBy={`${idBase}-${entry.key}`} />
                </div>
                <div className={styles.convoText}>{entry.text}</div>
              </li>
            ))}
          </ul>
        ),
    },
    {
      id: 'activity',
      label: `Activity (${activityEntries.length})`,
      content:
        activityEntries.length === 0 ? (
          <EmptyState compact className={styles.detailState} title="No activity recorded" />
        ) : (
          <ul className={styles.detailBody} role="list">
            {activityEntries.map((entry) => (
              <li key={entry.key} className={styles.activityEntry}>
                {/* Seconds stay here: tool calls land several to the second, and HH:MM alone would not tell them apart. */}
                <span className={styles.activityTime}>{formatClock(entry.timestamp, true)}</span>
                <Chip tone={entry.kind === 'tool' ? 'info' : 'accent'} className={styles.activityChip}>
                  {entry.label}
                </Chip>
                <span className={styles.activityDetail}>{entry.detail}</span>
              </li>
            ))}
          </ul>
        ),
    },
  ];

  return (
    <>
      <div className={styles.detailMeta}>
        <Chip tone={chip.tone} title={chip.title}>{chip.label}</Chip>
        <span>{facts}</span>
      </div>
      <Tabs
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        containerClassName={styles.detailTabs}
        tabListClassName={styles.tabList}
        tabClassName={styles.tab}
        activeTabClassName={styles.tabActive}
        panelClassName={styles.detailTabPanel}
      />
    </>
  );
}

function CopyButton({ text, describedBy }: { text: string; describedBy: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      showToast('Could not copy to the clipboard', 'error');
      return;
    }
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <IconButton
      size="sm"
      label={copied ? 'Copied' : 'Copy message'}
      aria-describedby={describedBy}
      onClick={handleCopy}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}
