/**
 * rehype plugin: wrap occurrences of saved (favorited) selection strings in the
 * rendered markdown with a clickable <mark className="saved-selection">, so a
 * user sees which phrases they've looked up via the AI popup — and can click to
 * open the saved record in the REVIEW tab.
 *
 * Kept as a tree transform (not a per-paragraph hack) so it works for text
 * anywhere in the document. Code/links/existing marks are skipped.
 *
 * Local minimal hast types avoid a hard dependency on the `hast` type package.
 */

export interface SavedSelectionTerm {
  /** The exact selected text to highlight. */
  text: string;
  /** uuid of the DbTranslationLog record (used for the REVIEW deep-link). */
  uuid: string;
  /** Optional user alias, shown in the hover tooltip. */
  alias: string;
}

interface HastText { type: 'text'; value: string; }
interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastChild[];
}
interface HastRoot { type: 'root'; children: HastChild[]; }
type HastChild = HastText | HastElement;

const SKIP_TAGS = new Set(['code', 'pre', 'a', 'mark', 'script', 'style']);
const MIN_TERM_LEN = 2;

/**
 * Build a rehype plugin (unified attacher) that highlights the given terms.
 * Returns a no-op transform when there are no usable terms.
 */
export function makeSavedSelectionsPlugin(terms: SavedSelectionTerm[]) {
  // De-dupe + drop trivially short terms, longest-first so a longer phrase wins
  // over a shorter one starting at the same position.
  const seen = new Set<string>();
  const cleaned: SavedSelectionTerm[] = [];
  for (const t of terms) {
    const text = t.text.trim();
    if (text.length < MIN_TERM_LEN) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ ...t, text });
  }
  cleaned.sort((a, b) => b.text.length - a.text.length);

  return () => (tree: HastRoot) => {
    if (cleaned.length === 0) return;
    walk(tree, cleaned);
  };
}

function walk(node: HastRoot | HastElement, terms: SavedSelectionTerm[]): void {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'text') {
      const pieces = splitText(child.value, terms);
      if (pieces) {
        children.splice(i, 1, ...pieces);
        i += pieces.length - 1;
      }
    } else if (child.type === 'element' && !SKIP_TAGS.has(child.tagName)) {
      walk(child, terms);
    }
  }
}

/** Split a text value into text + <mark> nodes; null if nothing matched. */
function splitText(value: string, terms: SavedSelectionTerm[]): HastChild[] | null {
  const lower = value.toLowerCase();
  const out: HastChild[] = [];
  let pos = 0;
  let matched = false;

  while (pos < value.length) {
    let best: { idx: number; term: SavedSelectionTerm } | null = null;
    for (const term of terms) {
      const idx = lower.indexOf(term.text.toLowerCase(), pos);
      if (idx !== -1 && (best === null || idx < best.idx)) {
        best = { idx, term };
        if (idx === pos) break; // earliest possible — longest already preferred by sort
      }
    }
    if (!best) break;
    matched = true;
    if (best.idx > pos) out.push({ type: 'text', value: value.slice(pos, best.idx) });
    const end = best.idx + best.term.text.length;
    out.push(markNode(value.slice(best.idx, end), best.term));
    pos = end;
  }

  if (!matched) return null;
  if (pos < value.length) out.push({ type: 'text', value: value.slice(pos) });
  return out;
}

function markNode(text: string, term: SavedSelectionTerm): HastElement {
  return {
    type: 'element',
    tagName: 'mark',
    properties: {
      className: ['saved-selection'],
      dataSavedUuid: term.uuid,
      title: term.alias || 'Saved lookup — click to open in REVIEW',
    },
    children: [{ type: 'text', value: text }],
  };
}
