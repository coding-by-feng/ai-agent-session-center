/**
 * ToolRow — one tool call in the chat (AASC-41): "Ran npm test ✓ 0:42" on one
 * line, collapsed; tapped open it shows the command, the input, the output (12
 * lines, then Show all) or, for an edit, the inline diff. A failed call is drawn
 * with a red edge and the word "Failed", never colour alone.
 *
 * Expansion is the chat's (`expanded` / `onToggle`, so search can open a row) at
 * the top level, and the row's own inside a folded group.
 */
import { lazy, memo, Suspense, useId, useState, type ComponentType } from 'react';
import type { ToolCall, ToolItem } from '@/lib/chat/buildChatItems';
import type { ToolCategory } from '@/lib/chat/toolSummary';
import { editFiles } from '@/lib/chat/editDiff';
import { formatDuration } from '@/lib/chat/chatFormat';
import OutputBlock from './OutputBlock';
import InlineDiff from './InlineDiff';
import { CheckIcon, ChevronIcon, CrossIcon, FileIcon, GlobeIcon, LockIcon, PencilIcon, SearchIcon, TerminalIcon, ToolIcon } from '../chatViewIcons';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

const ChatMarkdown = lazy(() => import('./ChatMarkdown'));

const ICONS: Record<ToolCategory, ComponentType<{ size?: number }>> = {
  read: FileIcon,
  edit: PencilIcon,
  command: TerminalIcon,
  search: SearchIcon,
  fetch: GlobeIcon,
  other: ToolIcon,
};

export function ToolStatus({ call }: { call: Pick<ToolCall, 'status' | 'durationMs'> }) {
  const time = formatDuration(call.durationMs);
  switch (call.status) {
    case 'done':
      return (
        <span className={styles.statusOk}>
          <CheckIcon size={14} />
          <span className={styles.srOnly}>done</span>
          {time && <span className={styles.duration}>{time}</span>}
        </span>
      );
    case 'failed':
      return (
        <span className={styles.statusFail}>
          <CrossIcon size={14} />
          Failed
        </span>
      );
    case 'running':
      return (
        <span className={styles.statusRun}>
          <span className={styles.spinner} aria-hidden="true" />
          Running
        </span>
      );
    case 'waiting':
      return <span className={styles.statusWait}>Waiting for you</span>;
    default:
      return <span className={styles.statusNone}>No result</span>;
  }
}

/** What a call was given, in words a person can read. */
function inputText(call: ToolCall): string {
  const input = call.input;
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  if (call.category === 'search') {
    return ['pattern', 'query', 'path', 'glob', 'type', 'output_mode']
      .filter((k) => typeof rec[k] === 'string' && rec[k])
      .map((k) => `${k}: ${String(rec[k])}`)
      .join('\n');
  }
  if (call.category === 'fetch') return [rec.url, rec.prompt].filter((v) => typeof v === 'string').join('\n');
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/** A proposed plan (ExitPlanMode), as the Markdown it is. */
function PlanDetail({ plan }: { plan: string }) {
  return (
    <div data-ai-context="">
      <Suspense fallback={<p className={styles.plainText}>{plan}</p>}>
        <ChatMarkdown text={plan} />
      </Suspense>
    </div>
  );
}

/** A question to you (AskUserQuestion): each question and its choices, in words. */
function QuestionDetail({ questions }: { questions: Rec[] }) {
  return (
    <>
      {questions.map((q, i) => (
        <div key={i} className={styles.question}>
          <p className={styles.questionText}>{typeof q.question === 'string' ? q.question : 'A question'}</p>
          {Array.isArray(q.options) && (
            <ul className={styles.choices}>
              {q.options.filter(isRec).map((o, j) => (
                <li key={j}>
                  <strong>{typeof o.label === 'string' ? o.label : `Choice ${j + 1}`}</strong>
                  {typeof o.description === 'string' && o.description ? ` — ${o.description}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </>
  );
}

function ToolDetail({ call }: { call: ToolCall }) {
  const edit = call.category === 'edit';
  const input = isRec(call.input) ? call.input : null;
  const plan = call.name === 'ExitPlanMode' && typeof input?.plan === 'string' ? input.plan : null;
  const questions = call.name === 'AskUserQuestion' && Array.isArray(input?.questions) ? input.questions.filter(isRec) : null;
  if (plan !== null || questions) {
    return (
      <>
        {plan !== null ? <PlanDetail plan={plan} /> : <QuestionDetail questions={questions!} />}
        {call.result && <OutputBlock text={call.result.output || '(no answer)'} prose label={plan !== null ? 'What you said' : 'Your answer'} />}
      </>
    );
  }
  const showInput = !edit && !call.command && !call.redacted
    && (call.category === 'search' || call.category === 'fetch' || call.category === 'other');
  const output = call.result?.output ?? '';
  return (
    <>
      {call.redacted && <p className={styles.note}>Hidden on phones: this touched a secret file.</p>}
      {call.path && <div className={styles.detailLabel}>{call.path}</div>}
      {edit && <InlineDiff files={editFiles(call.name, call.input)} />}
      {call.command && <OutputBlock text={`$ ${call.command}`} wrap label="Command" />}
      {showInput && inputText(call) && <OutputBlock text={inputText(call)} wrap label="Input" />}
      {call.result && (!edit || call.result.isError) && (
        <OutputBlock text={output || '(no output)'} label={call.result.isError ? 'Error' : 'Output'} wrap={call.redacted} />
      )}
      {call.result?.truncated && <p className={styles.note}>The Mac sent the first 4 KB of this output.</p>}
      {call.inputTruncated && <p className={styles.note}>The call’s input was longer than the phone receives.</p>}
      {call.status === 'running' && <p className={styles.note}>Running…</p>}
      {call.status === 'waiting' && <p className={styles.note}>Waiting for your approval or answer.</p>}
      {call.status === 'no-result' && <p className={styles.note}>No result was recorded for this call.</p>}
    </>
  );
}

export interface ToolRowProps {
  item: ToolItem;
  expanded?: boolean;
  onToggle?: (key: string) => void;
}

function ToolRow({ item, expanded: controlled, onToggle }: ToolRowProps) {
  const [own, setOwn] = useState(false);
  const detailId = useId();
  const expanded = controlled ?? own;
  const { call } = item;
  const Icon = ICONS[call.category];
  const toggle = () => (onToggle ? onToggle(item.key) : setOwn((v) => !v));
  return (
    <div>
      <button
        type="button"
        className={`${styles.row}${call.status === 'failed' ? ` ${styles.rowFailed}` : ''}`}
        aria-expanded={expanded}
        aria-controls={expanded ? detailId : undefined}
        onClick={toggle}
      >
        <span className={styles.rowIcon}><Icon size={18} /></span>
        <span className={styles.rowText}>
          <span className={styles.verb}>{call.verb}</span>
          {call.target && <> <span className={`${styles.target}${call.mono ? ` ${styles.mono}` : ''}`}>{call.target}</span></>}
        </span>
        {call.secret && (
          <span className={styles.secret}>
            <LockIcon size={14} />
            <span className={styles.srOnly}>a secret file</span>
          </span>
        )}
        {call.meta && <span className={styles.meta}>{call.meta}</span>}
        <ToolStatus call={call} />
        <span className={`${styles.chev}${expanded ? ` ${styles.chevOpen}` : ''}`}><ChevronIcon size={16} /></span>
      </button>
      {expanded && (
        <div id={detailId} className={styles.detail}>
          <ToolDetail call={call} />
        </div>
      )}
    </div>
  );
}

export default memo(ToolRow);
