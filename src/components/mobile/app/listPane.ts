/**
 * listPane — what a screen's "open" means where it is drawn (iPad split view, Nov 1 2026).
 *
 * In the split view a tab's root screen is the left list (`ListPane` provides
 * `ListPaneContext`), and opening something from it replaces the right pane
 * (`openFromRoot`). Everywhere else, the right pane and every phone, a screen
 * drills down as before (`push`, `openTerminal`), so a teammate opened from a
 * session's Agents tab, or Cloud from This phone, lands on top and Back returns.
 * Shared rows (SettingsRows sits in More and in More → Settings) ask here
 * rather than knowing where they are.
 */
import { createContext, useCallback, useContext } from 'react';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { sessionScreens } from '@/lib/chat/phoneRoutes';

export const ListPaneContext = createContext(false);

/** Open a screen from this one: the right pane from the list, else on top. */
export function useOpenScreen(): (path: string) => void {
  const inList = useContext(ListPaneContext);
  return useCallback((path: string) => {
    const nav = usePhoneNavStore.getState();
    if (inList) nav.openFromRoot([path]);
    else nav.push(path);
  }, [inList]);
}

/** Open a session's terminal (over its Chat when it has one, AASC-56): the right pane from the list, else on top. */
export function useOpenTerminalScreen(): (sessionId: string, hasChat?: boolean) => void {
  const inList = useContext(ListPaneContext);
  return useCallback((sessionId: string, hasChat = true) => {
    const nav = usePhoneNavStore.getState();
    if (inList) nav.openFromRoot(sessionScreens(sessionId, 'terminal', hasChat));
    else nav.openTerminal(sessionId, hasChat);
  }, [inList]);
}
