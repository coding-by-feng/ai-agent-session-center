/**
 * formatTokens — a token count in a few characters: 950, 3.7k, 263k, 41.1M ('?' for nothing countable). Shared by the
 * phone's usage sheet (lib/chat/usageModel.ts) and the desktop's context card (lib/contextDetails.ts); it lives
 * outside lib/chat/ so the desktop entry chunk takes no phone-only module (src/__tests__/phoneChunkBoundary.test.ts).
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
