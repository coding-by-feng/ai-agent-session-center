/**
 * Text normalization for find-in-file matching.
 *
 * Documents (especially typeset/academic markdown) use dash variants that look
 * like a plain hyphen but are different code points — e.g. a numeric range
 * "A1–A21" uses an EN DASH (U+2013) while users type a HYPHEN-MINUS (U+002D).
 * A literal `indexOf` then reports "No results" for visible text.
 *
 * `foldDashes` maps every dash/hyphen variant to U+002D so the two compare
 * equal. Every folded character is a single UTF-16 code unit (all ≤ U+FFFF),
 * so folding is **length-preserving** — match offsets and `term.length` slice
 * lengths stay aligned with the original (un-normalized) string.
 */

// Dash / hyphen / minus variants treated as equivalent to "-" (U+002D excluded
// since it is already the target). All single code units → 1:1 length.
//   U+2010 hyphen        U+2011 non-breaking hyphen  U+2012 figure dash
//   U+2013 en dash       U+2014 em dash              U+2015 horizontal bar
//   U+2212 minus sign    U+FE58 small em dash        U+FE63 small hyphen-minus
//   U+FF0D fullwidth hyphen-minus
const DASH_RE = /[‐-―−﹘﹣－]/g;

/** Fold every dash/hyphen variant to U+002D. Length-preserving. */
export function foldDashes(text: string): string {
  return text.replace(DASH_RE, '-');
}

/**
 * Normalize a string for find-in-file comparison: fold dashes, and case-fold
 * (`toLowerCase`) unless `caseSensitive`. Apply identically to both the search
 * term and the searched text so offsets line up.
 */
export function normalizeForSearch(text: string, caseSensitive: boolean): string {
  const dashed = foldDashes(text);
  return caseSensitive ? dashed : dashed.toLowerCase();
}
