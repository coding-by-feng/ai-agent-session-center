/**
 * mcpConfirmStore — the confirmations a central is waiting on, as this Mac's dashboard window shows them
 * (the card in `ConfirmStack`). The server is the source (`server/mcp/confirm.ts`): the pending ones are read from
 * GET /api/mcp/confirms whenever the socket (re)connects, and followed through `mcp_confirm` (one opened) and
 * `mcp_confirm_resolved` (one answered, expired or withdrawn), which the server sends to this Mac's own windows only.
 *
 * A view carries no confirmId (the central's id) and none of the call's arguments, so a window can never hold
 * what lets a central approve itself. Everything off the wire is parsed strictly, copied field by field, and
 * bounded in length, so whatever else arrives with a view is dropped here.
 *
 * The list is oldest first, holds a card once, and holds none past its `expiresAt`: the server counts an expired
 * confirmation as denied, so a card that outlived its time could only mislead. `prune` is what the stack calls
 * on its clock; the read and the push also drop them.
 *
 * `answer` posts the person's decision to the card's own id. The card goes whether the server took the answer
 * ("ok") or says there is nothing left to answer ("gone": it expired, or another window answered first), and stays
 * on a failure so the person can try again.
 *
 * Only the dashboard window follows any of this (useWebSocket): a pop-out never shows a card.
 * Reducers never change what they were given or held (a new array each time).
 */
import { create } from 'zustand';
import type { McpConfirmView } from '@/types/mcpConfirm';
import type { McpRisk } from '@/types/mcpEvents';

/** The longest `summary` the server sends (`CONFIRM_SUMMARY_MAX`). */
const SUMMARY_MAX = 300;
/** The longest `detail` the server sends (`CONFIRM_DETAIL_MAX`). */
const DETAIL_MAX = 2_000;
/** The longest id or tool name taken as one. */
const ID_MAX = 200;

const RISKS: ReadonlySet<string> = new Set<McpRisk>(['read', 'write', 'steers', 'ask', 'destructive', 'outward']);

export type ConfirmDecision = 'allow' | 'deny';
/** What an answer came to: taken, nothing left to answer, or not delivered. */
export type ConfirmAnswer = 'ok' | 'gone' | 'failed';

interface McpConfirmState {
  /** The pending confirmations, oldest first. Replaced, never edited in place. */
  confirms: McpConfirmView[];

  /** One confirmation opened (`mcp_confirm`): added, or replacing its older self. */
  apply: (raw: unknown) => void;
  /** One confirmation ended (`mcp_confirm_resolved`). */
  resolved: (cardId: string) => void;
  /** Drop the cards past their expiry at `now`. */
  prune: (now?: number) => void;
  /** Read the pending list. Never throws; a 404 empties the list, any other failure changes nothing. */
  load: () => Promise<void>;
  /** Answer one card. Never throws. */
  answer: (cardId: string, decision: ConfirmDecision) => Promise<ConfirmAnswer>;
}

const isId = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= ID_MAX;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One view of the wire format, or null when it is not one. Only the public fields are copied. */
export function parseConfirmView(raw: unknown): McpConfirmView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isId(r.cardId) || !isId(r.centralId) || !isId(r.tool)) return null;
  if (typeof r.risk !== 'string' || !RISKS.has(r.risk)) return null;
  if (typeof r.summary !== 'string' || r.summary.length > SUMMARY_MAX) return null;
  if (r.detail !== null && (typeof r.detail !== 'string' || r.detail.length > DETAIL_MAX)) return null;
  if (r.targetSessionId !== null && !isId(r.targetSessionId)) return null;
  if (!isTime(r.createdAt) || !isTime(r.expiresAt)) return null;
  return {
    cardId: r.cardId,
    centralId: r.centralId,
    tool: r.tool,
    risk: r.risk as McpRisk,
    summary: r.summary,
    detail: r.detail,
    targetSessionId: r.targetSessionId,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}

/** `views` with `view` added (or replacing the card of the same id), oldest first. */
function withView(views: readonly McpConfirmView[], view: McpConfirmView): McpConfirmView[] {
  const next = views.some((v) => v.cardId === view.cardId)
    ? views.map((v) => (v.cardId === view.cardId ? view : v))
    : [...views, view];
  return [...next].sort((a, b) => a.createdAt - b.createdAt);
}

/** The views that are still live at `now`. */
const liveAt = (views: readonly McpConfirmView[], now: number): McpConfirmView[] =>
  views.filter((v) => v.expiresAt > now);

/** Bumped by every push; a read that started before a push merges instead of replacing. */
let pushes = 0;
/** The cards that ended while a read was in flight: that read's list may still hold them. */
let endedDuringRead = new Set<string>();
let readsInFlight = 0;

async function readConfirms(): Promise<{ kind: 'list'; views: McpConfirmView[] } | { kind: 'gone' } | null> {
  try {
    const res = await fetch('/api/mcp/confirms');
    if (res.status === 404) return { kind: 'gone' };
    if (!res.ok) return null;
    const body = (await res.json()) as { confirms?: unknown };
    if (!Array.isArray(body.confirms)) return null;
    const views = body.confirms.map(parseConfirmView).filter((v): v is McpConfirmView => v !== null);
    return { kind: 'list', views };
  } catch {
    return null;
  }
}

export const useMcpConfirmStore = create<McpConfirmState>((set, get) => ({
  confirms: [],

  apply: (raw) => {
    const view = parseConfirmView(raw);
    if (!view || view.expiresAt <= Date.now()) return;
    pushes += 1;
    endedDuringRead.delete(view.cardId);
    set({ confirms: withView(get().confirms, view) });
  },

  resolved: (cardId) => {
    pushes += 1;
    if (readsInFlight > 0) endedDuringRead.add(cardId);
    set({ confirms: get().confirms.filter((v) => v.cardId !== cardId) });
  },

  prune: (now = Date.now()) => {
    const held = get().confirms;
    const live = liveAt(held, now);
    if (live.length !== held.length) set({ confirms: live });
  },

  load: async () => {
    const startedAt = pushes;
    readsInFlight += 1;
    const read = await readConfirms();
    readsInFlight -= 1;
    const ended = endedDuringRead;
    if (readsInFlight === 0) endedDuringRead = new Set();
    if (read === null) return;
    if (read.kind === 'gone') {
      set({ confirms: [] });
      return;
    }
    const now = Date.now();
    const fresh = liveAt(read.views, now).filter((v) => !ended.has(v.cardId));
    if (pushes === startedAt) {
      set({ confirms: fresh.sort((a, b) => a.createdAt - b.createdAt) });
      return;
    }
    // A push overtook the read: what the window already holds is newer than the list, so it wins.
    const held = liveAt(get().confirms, now);
    const merged = fresh.reduce((acc, v) => (acc.some((h) => h.cardId === v.cardId) ? acc : withView(acc, v)), held);
    set({ confirms: merged });
  },

  answer: async (cardId, decision) => {
    let outcome: ConfirmAnswer;
    try {
      const res = await fetch(`/api/mcp/confirm/${encodeURIComponent(cardId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      // 404: unknown or expired. 409: another window answered first. Either way nothing is left to answer.
      outcome = res.ok ? 'ok' : res.status === 404 || res.status === 409 ? 'gone' : 'failed';
    } catch {
      outcome = 'failed';
    }
    if (outcome !== 'failed') set({ confirms: get().confirms.filter((v) => v.cardId !== cardId) });
    return outcome;
  },
}));
