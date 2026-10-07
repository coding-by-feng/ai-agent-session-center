/**
 * A failed HTTP request that keeps its status, so a view can tell "try again"
 * failures from refusals. Shared by the HISTORY view and its detail dialog;
 * import-free so any view can use it.
 */
export class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * The JSON body of an OK response. Otherwise a RequestError carrying the
 * server's own reason when it sent one (a remote device is refused with
 * "history is only available on the host machine"), else the fallback and the
 * HTTP status.
 */
export async function readJson<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  const body: unknown = await res.json().catch(() => null);
  const reason = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
  throw new RequestError(
    typeof reason === 'string' && reason ? reason : `${fallback} (HTTP ${res.status})`,
    res.status,
  );
}

/** A refusal (403) or a thing that is gone (404): asking again changes nothing. */
export function canRetry(error: Error | null): boolean {
  return !(error instanceof RequestError && (error.status === 403 || error.status === 404));
}

/**
 * The app QueryClient's `retry` (App.tsx): one retry for a failure worth
 * repeating, none for a refusal or a missing thing (`canRetry`). A plain Error
 * from any other fetcher still gets its one retry.
 */
export function retryOnceUnlessRefused(failures: number, error: Error): boolean {
  return canRetry(error) && failures < 1;
}
