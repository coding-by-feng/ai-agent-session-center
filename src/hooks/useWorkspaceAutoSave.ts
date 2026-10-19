/**
 * useWorkspaceAutoSave — triggers a debounced auto-save of the workspace
 * snapshot whenever sessions or rooms change, and a quicker one when somebody
 * changes a per-session queue switch (Auto-send, pause, ...).
 *
 * The switches live in the queue store and change neither `sessions` nor
 * `rooms`. The snapshot is the only record a restart can read for a session whose
 * id changes, and it is what a restored card shows before the CLI reports in, so
 * watching them here is the difference between "Auto-send OFF is remembered" and
 * "the session comes back ON and its held prompts go out".
 *
 * A SHARE click does change `sessions`, but the 5 s session timer is reset by every
 * session update, so on a busy board it waited for a lull — quit before then and the
 * restart restored the old share state. It takes the quick save too.
 */
import { useEffect, useRef } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { useQueueStore } from '@/stores/queueStore';
import { scheduleAutoSave, scheduleAutomationSave, cancelAutoSave } from '@/lib/workspaceSnapshot';
import { automationIntentChanged } from '@/lib/queueAutomationDiff';
import { shareIntentChanged } from '@/lib/shareIntentDiff';

// Read at save time, so the debounced callback always sees the latest state.
const currentSessions = () => useSessionStore.getState().sessions;
const currentRooms = () => useRoomStore.getState().rooms;

export function useWorkspaceAutoSave(): void {
  const sessions = useSessionStore((s) => s.sessions);
  const rooms = useRoomStore((s) => s.rooms);
  const automation = useQueueStore((s) => s.automation);

  useEffect(() => {
    // Skip initial render — only auto-save after actual changes
    scheduleAutoSave(currentSessions, currentRooms);
  }, [sessions, rooms]);

  // A session's SHARE (📡) was flipped — by this device, another one, or "Share all now".
  const seenSessions = useRef(sessions);
  useEffect(() => {
    const before = seenSessions.current;
    seenSessions.current = sessions;
    if (shareIntentChanged(before, sessions)) scheduleAutomationSave(currentSessions, currentRooms);
  }, [sessions]);

  // A switch was changed by somebody. Mounting is not a change, and neither is a
  // row loaded at boot, a sync echo, or a re-key moving a config to a new id (see
  // queueAutomationDiff): a save after a re-key could write unresolved `term-*` ids.
  const seenAutomation = useRef(automation);
  useEffect(() => {
    const before = seenAutomation.current;
    if (before === automation) return;
    seenAutomation.current = automation;
    if (automationIntentChanged(before, automation)) scheduleAutomationSave(currentSessions, currentRooms);
  }, [automation]);

  // Cleanup on unmount
  useEffect(() => cancelAutoSave, []);
}
