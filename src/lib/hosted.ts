/** Injected only into hosted Lite HTML by the runtime; contains no credential. */
export function hostedParent(): string | null {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="aasc-hosted-parent"]')?.content ?? null
  );
}
