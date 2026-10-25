import type { CloudJob } from '@/types/cloudResources';
export function cloudJobProgress(job: CloudJob): string {
  return `${job.steps.filter((s) => s.state === 'complete').length} of ${job.steps.length} complete`;
}
export function cloudPackageSize(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
}
/** "1 job", "2 jobs" — never "1 jobs". */
export function cloudCount(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
const AGENT_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', shared: 'Shared' };
const KIND_LABELS: Record<string, string> = {
  skill: 'skill',
  command: 'command',
  rule: 'rule',
  agent: 'agent',
  instruction: 'instructions',
  memory: 'memory',
};
/** "Claude skill", "Codex memory" — a cloud resource's agent and kind in words. */
export function resourceKindLabel(agent: string, kind: string): string {
  return `${AGENT_LABELS[agent] ?? agent} ${KIND_LABELS[kind] ?? kind}`;
}
