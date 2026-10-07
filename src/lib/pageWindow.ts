/**
 * The page numbers a pager shows: the first, the last, and `radius` either
 * side of the current one, with 'gap' where pages are skipped. A gap that would
 * hide a single page shows that page instead — "1 … 3" saves nothing over
 * "1 2 3". Pure and import-free; `Pagination` renders it.
 */
export function pageWindow(current: number, total: number, radius = 2): (number | 'gap')[] {
  const out: (number | 'gap')[] = [];
  let last = 0;
  for (let i = 1; i <= total; i++) {
    const shown = i === 1 || i === total || (i >= current - radius && i <= current + radius);
    if (!shown) continue;
    if (last && i - last === 2) out.push(last + 1);
    else if (last && i - last > 2) out.push('gap');
    out.push(i);
    last = i;
  }
  return out;
}
