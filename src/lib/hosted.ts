/** Injected only into hosted HTML by the runtime; contains no credential. */
export function hostedParent(): string | null {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="aasc-hosted-parent"]')?.content ?? null
  );
}

export function hostedBase(): string {
  const base = document.querySelector<HTMLMetaElement>('meta[name="aasc-ui-base"]')?.content;
  return base === '/ui/lite' || base === '/ui/full' ? base : '';
}

/** UI-only path; API and WebSocket addresses stay at the runtime root. */
export function hostedUiPath(path: string): string {
  return `${hostedBase()}${path}`;
}
