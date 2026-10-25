/**
 * @module secretHits
 * Where a resource's "possible secret" is (Oct 26 2026). A cloud save refuses any file whose text
 * `redactText` changes; this says which lines it changed, so the refusal can name them:
 *
 *   Possible secret detected in the resource. Remove it before copying.
 *   SKILL.md · line 61: done | sort -u ****** /tmp/drift.tsv
 *   +2 more
 *
 * Each excerpt is the line AFTER redaction: the value itself never leaves the server, only the
 * masked line a detail view already shows. Redaction keeps every line in place (no rule matches
 * across or adds a newline), so line N of both texts is the same line.
 */
import { MASK, REDACT_LINE_MAX } from '../resourceMask.js';

export const SECRET_REFUSAL = 'Possible secret detected in the resource. Remove it before copying.';
/** Hits named in a refusal; the rest are counted. */
export const SECRET_HITS_SHOWN = 3;
/** The longest excerpt, cut around the first mask. */
const EXCERPT_CAP = 120;
const EXCERPT_LEAD = 40;

export interface SecretHit {
  /** 1-based. */
  line: number;
  /** The masked line, or null when the line is too long for the check to read (it is cut, which counts). */
  excerpt: string | null;
}

/** A masked line, trimmed and cut to `EXCERPT_CAP` around its first mask. */
function excerptOf(masked: string): string {
  const line = masked.trim();
  if (line.length <= EXCERPT_CAP) return line;
  const at = Math.max(0, line.indexOf(MASK));
  const start = Math.max(0, Math.min(at - EXCERPT_LEAD, line.length - EXCERPT_CAP));
  const body = line.slice(start, start + EXCERPT_CAP);
  return `${start > 0 ? '…' : ''}${body}${start + EXCERPT_CAP < line.length ? '…' : ''}`;
}

/** Every line `redacted` changed, in order; empty when the line counts differ (nothing to align). */
export function secretHits(text: string, redacted: string): SecretHit[] {
  const before = text.split('\n');
  const after = redacted.split('\n');
  if (before.length !== after.length) return [];
  const hits: SecretHit[] = [];
  before.forEach((line, i) => {
    if (line === after[i]) return;
    hits.push({ line: i + 1, excerpt: line.length > REDACT_LINE_MAX ? null : excerptOf(after[i]) });
  });
  return hits;
}

/** The refusal for one file: the headline, then up to `SECRET_HITS_SHOWN` hits, then "+N more". */
export function secretRefusal(file: string, text: string, redacted: string): string {
  const hits = secretHits(text, redacted);
  const shown = hits.slice(0, SECRET_HITS_SHOWN).map(
    (h) => `${file} · line ${h.line}: ${h.excerpt ?? 'line too long to check'}`,
  );
  const more = hits.length > SECRET_HITS_SHOWN ? [`+${hits.length - SECRET_HITS_SHOWN} more`] : [];
  return [SECRET_REFUSAL, ...shown, ...more].join('\n');
}
