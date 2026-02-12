/**
 * @module utils
 * Shared utility functions: HTML/attribute escaping, color sanitization,
 * duration/time formatting, and debug logging controlled by localStorage.
 */

const DEBUG = localStorage.getItem('debug') === 'true';

export function debugLog(...args) {
  if (DEBUG) console.log(...args);
}

export function debugWarn(...args) {
  if (DEBUG) console.warn(...args);
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

export function sanitizeColor(color) {
  if (!color) return 'var(--accent-cyan)';
  if (typeof color === 'string' && HEX_COLOR_RE.test(color)) return color;
  // Allow CSS variable references
  if (typeof color === 'string' && color.startsWith('var(--') && color.endsWith(')')) return color;
  return 'var(--accent-cyan)';
}

export function formatDuration(ms) {
  if (!ms || isNaN(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

export function sanitizeNumber(val) {
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}
