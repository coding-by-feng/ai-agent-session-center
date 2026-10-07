/**
 * Project filter options for HISTORY and PROMPTS: one option per project PATH.
 *
 * `GET /api/db/projects` is `SELECT DISTINCT project_path, project_name`, so a
 * project whose sessions were recorded under two names ("Home", "kasonzhan")
 * comes back twice with one path. Two <option>s with the same value cannot be
 * told apart — picking the second shows the first — and they collide as React
 * keys. The names are joined instead ("Home / kasonzhan"), in server order.
 */
import type { DistinctProject } from '@/types';

export function uniqueProjectOptions(
  projects: readonly DistinctProject[] | undefined,
): { value: string; label: string }[] {
  const names = new Map<string, string[]>();
  for (const p of projects ?? []) {
    const list = names.get(p.project_path) ?? [];
    const name = p.project_name || p.project_path;
    if (!list.includes(name)) names.set(p.project_path, [...list, name]);
  }
  return Array.from(names, ([value, labels]) => ({ value, label: labels.join(' / ') }));
}
