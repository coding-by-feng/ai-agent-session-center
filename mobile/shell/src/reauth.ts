// reauth.ts — the loaded UI sends the WebView back here when its session lapses (AASC-17).
//
// `?reauth=1&back=/path`. `back` must be a path on the paired server: an
// absolute or protocol-relative URL is refused, so a crafted link can't make
// the shell navigate somewhere else after signing in.

export function parseReauthRequest(search: string): { back: string } | null {
  const p = new URLSearchParams(search);
  if (p.get('reauth') !== '1') return null;
  const back = p.get('back') ?? '/';
  const safe = back.startsWith('/') && !back.startsWith('//') && !back.includes('\\') ? back : '/';
  return { back: safe };
}

export function returnUrl(origin: string, back: string): string {
  return `${origin}${back.startsWith('/') && !back.startsWith('//') ? back : '/'}`;
}
