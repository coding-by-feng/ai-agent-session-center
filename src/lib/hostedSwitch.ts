import { isProjectEditing } from './projectEditGuard';
import { useSessionStore } from '@/stores/sessionStore';

export function hasUnsavedProjectEdits(): boolean {
  return [...useSessionStore.getState().sessions.keys()].some(isProjectEditing);
}

export async function checkHostedEdition(edition: 'lite' | 'full'): Promise<void> {
  if (hasUnsavedProjectEdits()) throw new Error('unsaved_files');
  const response = await fetch(`/ui/${edition}/`, {
    method: 'HEAD',
    cache: 'no-store',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html'))
    throw new Error('edition_unavailable');
}

export async function handleHostedSwitch(
  event: MessageEvent,
  deps: {
    origin: string;
    parent: Window;
    check: (edition: 'lite' | 'full') => Promise<void>;
    flush: () => Promise<void>;
    navigate: (path: string) => void;
    reply: (message: unknown) => void;
  },
): Promise<boolean> {
  if (
    event.origin !== deps.origin ||
    event.source !== deps.parent ||
    event.data?.type !== 'aasc:hosted-switch' ||
    !['lite', 'full'].includes(event.data.edition)
  )
    return false;
  try {
    await deps.check(event.data.edition);
    await deps.flush();
    deps.navigate(`/ui/${event.data.edition}/`);
  } catch (error) {
    const reason =
      error instanceof Error && ['unsaved_files', 'edition_unavailable'].includes(error.message)
        ? error.message
        : 'save_failed';
    deps.reply({ type: 'aasc:hosted-switch-error', reason });
  }
  return true;
}
