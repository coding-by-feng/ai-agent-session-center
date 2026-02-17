/**
 * Formatting utilities ported from public/js/utils.js.
 */

export function formatDuration(ms: number): string {
  if (!ms || isNaN(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SOURCE_LABELS: Record<string, string> = {
  vscode: 'VS Code',
  jetbrains: 'JetBrains',
  iterm: 'iTerm',
  warp: 'Warp',
  kitty: 'Kitty',
  ghostty: 'Ghostty',
  alacritty: 'Alacritty',
  wezterm: 'WezTerm',
  hyper: 'Hyper',
  terminal: 'Terminal',
  tmux: 'tmux',
};

export function getSourceLabel(source: string): string {
  return SOURCE_LABELS[source] || source;
}

export function getStatusLabel(status: string): string {
  if (status === 'ended') return 'DISCONNECTED';
  if (status === 'approval') return 'APPROVAL NEEDED';
  if (status === 'input') return 'WAITING FOR INPUT';
  if (status === 'waiting') return 'WAITING';
  return status.toUpperCase();
}
