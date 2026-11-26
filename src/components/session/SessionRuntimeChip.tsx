/**
 * SessionRuntimeChip — the model and effort a Claude session is running with, in its
 * header beside the plan-usage chip. It follows `/model` and `/effort` live, whether
 * typed in the terminal or sent by a queue step (see `server/sessionRuntime.ts`).
 * Once Claude Code reports it, a third segment shows how full the context window is.
 *
 * The tooltip says where the values come from. Since Nov 25 2026 a click opens the Context
 * details card (`ContextDetailsPopover`): tokens, cache hit rates, the reference cost. Lite
 * keeps the read-only `<span>` (`role="status"`, which reads a change aloud): new UI is Full-only.
 */
import { useCallback, useId, useRef, useState, type ReactElement } from 'react';
import Tooltip from '@/components/ui/Tooltip';
import { IS_LITE } from '@/lib/edition';
import { resolveContextDisplay, resolveRuntimeDisplay, type ContextDisplay } from '@/lib/sessionRuntime';
import type { Session } from '@/types';
import { EffortIcon } from './EffortStepPicker';
import { ModelIcon } from './ModelStepPicker';
import ContextDetailsPopover from './ContextDetailsPopover';
import styles from '@/styles/modules/DetailPanel.module.css';
import detailStyles from '@/styles/modules/ContextDetails.module.css';

function sourceNote(live: boolean, effortLive: boolean, hasEffort: boolean): string {
  if (!live) return 'What this session was launched with. Updates as soon as Claude Code reports its live model and effort.';
  if (!hasEffort && effortLive) return 'Reported by Claude Code. Effort is saved per model, so after a model switch it shows again with the next reply.';
  return 'Reported by Claude Code. Updates when /model or /effort runs — typed in the terminal or sent by a queue step.';
}

const tokenCount = (n: number): string => n.toLocaleString('en-US');

function contextNote(ctx: ContextDisplay): string {
  const amount = ctx.tokens !== undefined && ctx.size
    ? `${tokenCount(ctx.tokens)} of ${tokenCount(ctx.size)} tokens (${ctx.pct}%)`
    : `${ctx.pct}% used`;
  const tail = ctx.level === 'high' ? ' Claude Code compacts automatically near the limit.' : '';
  return `Context window: ${amount}. Updates with each reply.${tail}`;
}

/** A ring filled to the used share — the band colour is on the glyph, never the text. */
function ContextIcon({ pct }: { pct: number }) {
  const r = 4;
  const circumference = 2 * Math.PI * r;
  return (
    <svg width="11" height="11" viewBox="0 0 10 10" focusable="false">
      <circle cx="5" cy="5" r={r} fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
      <circle
        cx="5" cy="5" r={r} fill="none" stroke="currentColor" strokeWidth="2"
        strokeDasharray={`${(circumference * pct) / 100} ${circumference}`}
        transform="rotate(-90 5 5)"
      />
    </svg>
  );
}

export default function SessionRuntimeChip({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const cardId = useId();
  const close = useCallback(() => setOpen(false), []);
  const view = resolveRuntimeDisplay(session);
  if (!view) return null;
  const ctx = resolveContextDisplay(session);
  const spoken = [
    `Model ${view.model}`,
    view.effort && `effort ${view.effort}`,
    ctx && `context ${ctx.pct}% used`,
  ].filter(Boolean).join(', ');
  const source = sourceNote(view.live, view.effortLive, Boolean(view.effort));
  const body = (
    <>
      <span className={styles.runtimeModelIcon} aria-hidden="true"><ModelIcon /></span>
      <span className={styles.runtimeModel}>{view.model}</span>
      {view.effort && (
        <span className={styles.runtimeEffort} data-part="effort">
          <span className={styles.runtimeEffortIcon} aria-hidden="true"><EffortIcon /></span>
          {view.effort}
        </span>
      )}
      {ctx && (
        // The % moves with most replies, so it is not announced on its own — a screen
        // reader hears it in the chip's name.
        <span className={styles.runtimeContext} data-part="context" data-level={ctx.level} aria-live="off">
          <span className={styles.runtimeContextIcon} aria-hidden="true"><ContextIcon pct={ctx.pct} /></span>
          {ctx.pct}%
        </span>
      )}
    </>
  );
  const description = ctx ? `${source} ${contextNote(ctx)}` : source;
  const tooltip = (child: ReactElement, disabled = false) => (
    <Tooltip
      label={view.effort ? `${view.model} · ${view.effort} effort` : view.model}
      description={IS_LITE ? description : `${description} Click for token details.`}
      placement="bottom"
      disabled={disabled}
    >
      {child}
    </Tooltip>
  );

  if (IS_LITE) {
    return tooltip(
      <span className={styles.runtimeChip} role="status" aria-label={spoken} data-live={String(view.live)}>
        {body}
      </span>,
    );
  }

  const button = (
    <button
      ref={buttonRef}
      type="button"
      className={`${styles.runtimeChip} ${detailStyles.chipButton}`}
      aria-label={`${spoken}. Context details`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? cardId : undefined}
      data-live={String(view.live)}
      onClick={() => setOpen((o) => !o)}
    >
      {body}
    </button>
  );
  return (
    <>
      {/* The tooltip would sit on top of the card it describes: it steps aside while open. */}
      {tooltip(button, open)}
      {open && <ContextDetailsPopover session={session} anchorRef={buttonRef} id={cardId} onClose={close} />}
    </>
  );
}
