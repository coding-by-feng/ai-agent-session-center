/**
 * useAlertConfigSync — loads the alert level table (Settings ▸ Sound ▸ Alert levels, `GET /api/alert-levels`) when
 * the main window starts and whenever it regains focus, so a change made in another window (a pop-out, another
 * browser) is picked up (Nov 25 2026). No central tool writes the table. There is no push for it: the table changes
 * rarely, by hand. Mounted once in AppLayout; the phone app keeps the default table.
 */
import { useEffect } from 'react';
import { useAlertConfigStore } from '@/stores/alertConfigStore';

export function useAlertConfigSync(): void {
  useEffect(() => {
    const load = () => { void useAlertConfigStore.getState().load(); };
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
}
