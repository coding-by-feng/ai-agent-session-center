/**
 * useAiPopupsOn — may this session's text start an AI popup right now?
 *
 * The desktop's rule in one place for the phone's surfaces (AASC-57): the popup is
 * on (`translationEnabled`), its trigger is not "Disabled", and the session's own
 * switch is on, read through isAiPopupEnabled (unset means on).
 */
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { isAiPopupEnabled } from '@/lib/aiPopup';

export function useAiPopupsOn(sessionId: string | null | undefined): boolean {
  const translationEnabled = useSettingsStore((s) => s.translationEnabled);
  const trigger = useSettingsStore((s) => s.translationTrigger);
  const sessionOn = useSessionStore((s) => (sessionId ? isAiPopupEnabled(s.sessions.get(sessionId)) : false));
  return !!sessionId && translationEnabled && trigger !== 'off' && sessionOn;
}
