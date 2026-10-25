/**
 * ResourceUsageFacts — the detail pane's use line (Oct 23 2026):
 * "Used 17× in the last 90 days · 12 typed by you · 5 by the agent · last used 2h ago",
 * then what it was counted by. A rule gets a line saying why it has no count, since
 * the question "how often is this rule used" has no answer: it loads into every session.
 */
import type { ResourceSummary } from '@/types/resources';
import { isUsageCounted, usageFacts } from '@/lib/resourceUsage';
import type { LibraryUsage } from './useResourceUsage';
import lib from '@/styles/modules/ResourceLibrary.module.css';

export default function ResourceUsageFacts({
  summary,
  usage,
  now,
}: {
  summary: ResourceSummary;
  usage: LibraryUsage | null | undefined;
  now: number;
}) {
  if (summary.type === 'rule') {
    return <p className={lib.usageNote}>No use count: a rule loads into every session, and nothing invokes it.</p>;
  }
  if (!usage || !isUsageCounted(summary.type)) return null;
  const facts = usageFacts(summary, usage.byId.get(summary.id), usage.windowDays, now);
  return (
    <>
      <p className={lib.usageFacts}>
        <span className={lib.usageHeadline}>{facts.headline}</span>
        {facts.parts.map((part) => ` · ${part}`).join('')}
      </p>
      {facts.note && <p className={lib.usageNote}>{facts.note}</p>}
    </>
  );
}
