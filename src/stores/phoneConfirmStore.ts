/**
 * phoneConfirmStore — the central-session confirmations a paired phone may answer, as the phone's Inbox shows
 * them (`PhoneConfirmCard`). The server is the source (`server/mcp/phoneConfirmRoutes.ts`, P5-15): it sends a card
 * only when the tool is one the phone could already do itself and the sessions involved are shared with it.
 * The pending ones are read from GET /api/phone-confirms whenever the socket (re)connects, and followed through
 * `mcp_phone_confirm` (one opened) and `mcp_phone_confirm_resolved` (one answered, expired or withdrawn).
 *
 * It is the desktop `mcpConfirmStore` for the phone, and takes its parser from there so the two read one wire
 * format: a view carries no confirmId and none of the call's arguments, and only the public fields are copied.
 * The list is oldest first (a newer card never moves an older card's buttons), holds a card once, and holds none
 * past its `expiresAt`: the server counts an expired card as denied.
 *
 * A held card's `expiresAt` is on THIS phone's clock, set once when the card first arrives, so a phone whose clock is
 * off from the Mac's still counts the card's own time: a pushed card gets its whole time (`expiresAt − createdAt`,
 * both the Mac's) from its arrival; a card first read from the list gets the time it had left when the Mac answered
 * the read (the answer's `now`, the Mac's clock). A card that arrives again keeps the deadline it already has.
 *
 * `answer` posts the decision to the card's own id. The card goes whether the server took it ("ok") or says there
 * is nothing left to answer ("gone": expired, answered on the Mac, or no longer shared), and stays on a failure
 * so the person can try again. Reducers never change what they were given or held.
 */
import { create } from 'zustand';
import type { McpConfirmView } from '@/types/mcpConfirm';
import { parseConfirmView, type ConfirmAnswer, type ConfirmDecision } from '@/stores/mcpConfirmStore';

interface PhoneConfirmState {
  /** The pending confirmations, oldest first. Replaced, never edited in place. */
  confirms: McpConfirmView[];

  /** One confirmation opened (`mcp_phone_confirm`): added, or replacing its older self. */
  apply: (raw: unknown) => void;
  /** One confirmation ended (`mcp_phone_confirm_resolved`). */
  resolved: (cardId: string) => void;
  /** Drop the cards past their expiry at `now`. */
  prune: (now?: number) => void;
  /** Read the pending list. Never throws; a 404 empties the list, any other failure changes nothing. */
  load: () => Promise<void>;
  /** Answer one card. Never throws. */
  answer: (cardId: string, decision: ConfirmDecision) => Promise<ConfirmAnswer>;
}

const withView = (views: readonly McpConfirmView[], view: McpConfirmView): McpConfirmView[] => {
  const next = views.some((v) => v.cardId === view.cardId)
    ? views.map((v) => (v.cardId === view.cardId ? view : v))
    : [...views, view];
  return [...next].sort((a, b) => a.createdAt - b.createdAt);
};

const liveAt = (views: readonly McpConfirmView[], now: number): McpConfirmView[] =>
  views.filter((v) => v.expiresAt > now);

/**
 * The view with its deadline on this phone's clock: the deadline `held` already gave it, else `arrivedAt` plus the
 * time it has left. That is its whole time, or less when the Mac's clock at sending (`macNow`) is known.
 */
function onPhoneClock(
  view: McpConfirmView,
  held: readonly McpConfirmView[],
  arrivedAt: number,
  macNow?: number,
): McpConfirmView {
  const known = held.find((v) => v.cardId === view.cardId);
  if (known) return { ...view, expiresAt: known.expiresAt };
  const life = view.expiresAt - view.createdAt;
  const left = macNow === undefined ? life : Math.min(life, view.expiresAt - macNow);
  return { ...view, expiresAt: arrivedAt + left };
}

/** Bumped by every push; a read that started before a push merges instead of replacing. */
let pushes = 0;
/** The cards that ended while a read was in flight: that read's list may still hold them. */
let endedDuringRead = new Set<string>();
let readsInFlight = 0;

type ConfirmsRead = { kind: 'list'; views: McpConfirmView[]; macNow?: number } | { kind: 'gone' } | null;

async function readConfirms(): Promise<ConfirmsRead> {
  try {
    const res = await fetch('/api/phone-confirms');
    if (res.status === 404) return { kind: 'gone' };
    if (!res.ok) return null;
    const body = (await res.json()) as { confirms?: unknown; now?: unknown };
    if (!Array.isArray(body.confirms)) return null;
    const views = body.confirms.map(parseConfirmView).filter((v): v is McpConfirmView => v !== null);
    return typeof body.now === 'number' && Number.isFinite(body.now)
      ? { kind: 'list', views, macNow: body.now }
      : { kind: 'list', views };
  } catch {
    return null;
  }
}

export const usePhoneConfirmStore = create<PhoneConfirmState>((set, get) => ({
  confirms: [],

  apply: (raw) => {
    const parsed = parseConfirmView(raw);
    if (!parsed) return;
    const now = Date.now();
    const view = onPhoneClock(parsed, get().confirms, now);
    if (view.expiresAt <= now) return;
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
    const timed = read.views.map((v) => onPhoneClock(v, get().confirms, now, read.macNow));
    const fresh = liveAt(timed, now).filter((v) => !ended.has(v.cardId));
    if (pushes === startedAt) {
      set({ confirms: fresh.sort((a, b) => a.createdAt - b.createdAt) });
      return;
    }
    // A push overtook the read: what the phone already holds is newer than the list, so it wins.
    const held = liveAt(get().confirms, now);
    set({ confirms: fresh.reduce((acc, v) => (acc.some((h) => h.cardId === v.cardId) ? acc : withView(acc, v)), held) });
  },

  answer: async (cardId, decision) => {
    let outcome: ConfirmAnswer;
    try {
      const res = await fetch(`/api/phone-confirms/${encodeURIComponent(cardId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      // 404: unknown, expired or not answerable now. 409: answered on the Mac first. Either way nothing is left.
      outcome = res.ok ? 'ok' : res.status === 404 || res.status === 409 ? 'gone' : 'failed';
    } catch {
      outcome = 'failed';
    }
    if (outcome !== 'failed') set({ confirms: get().confirms.filter((v) => v.cardId !== cardId) });
    return outcome;
  },
}));
