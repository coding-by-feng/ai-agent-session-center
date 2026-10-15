/**
 * useChatLive — keeps a session's chat current while it is on screen (AASC-41).
 *
 * There is no WebSocket message for the transcript: every `session_update` already
 * carries the session, and its activity (status, last activity, tool calls,
 * prompts, replies) moving is the cue to read what was written since (`after=`).
 * The first change waits 250 ms; reads never come closer than 250 ms apart (at most
 * four a second), and changes arriving meanwhile ride on the read already planned.
 * While the agent works a slow poll covers anything no hook announced; when it stops,
 * one more read a moment later catches a last line written after the Stop hook; and
 * coming back to the app reads again. Only the screen on show reads (useScreenSlot).
 */
import { useEffect, useRef } from 'react';
import type { Session } from '@/types';
import { retainChat, useChatStore } from '@/stores/chatStore';
import { useScreenSlot } from '../kit';

const FIRST_WAIT_MS = 250;
const MIN_GAP_MS = 250;
const WORKING_POLL_MS = 8_000;
const AFTER_STOP_MS = 1_500;

const activityOf = (s: Session): string =>
  `${s.status}|${s.lastActivityAt}|${s.totalToolCalls}|${s.promptHistory?.length ?? 0}|${s.responseLog?.length ?? 0}|${s.subagentCount ?? 0}`;

export function useChatLive(session: Session): void {
  const { sessionId } = session;
  const { isTop } = useScreenSlot();
  const working = session.status === 'working' || session.status === 'prompting';
  const activity = activityOf(session);

  useEffect(() => {
    const release = retainChat(sessionId);
    void useChatStore.getState().open(sessionId);
    return release;
  }, [sessionId]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRead = useRef(0);
  const seen = useRef(activity);

  useEffect(() => {
    if (!isTop || activity === seen.current) return;
    seen.current = activity;
    if (timer.current) return; // a read is already planned: it will see this change too
    const wait = Math.max(FIRST_WAIT_MS, lastRead.current + MIN_GAP_MS - Date.now());
    timer.current = setTimeout(() => {
      timer.current = null;
      lastRead.current = Date.now();
      void useChatStore.getState().refresh(sessionId);
    }, wait);
  }, [activity, isTop, sessionId]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, [sessionId]);

  useEffect(() => {
    if (!isTop || !working) return;
    const id = setInterval(() => void useChatStore.getState().refresh(sessionId), WORKING_POLL_MS);
    return () => clearInterval(id);
  }, [isTop, working, sessionId]);

  const wasWorking = useRef(working);
  useEffect(() => {
    const stopped = wasWorking.current && !working;
    wasWorking.current = working;
    if (!isTop || !stopped) return;
    const id = setTimeout(() => void useChatStore.getState().refresh(sessionId), AFTER_STOP_MS);
    return () => clearTimeout(id);
  }, [working, isTop, sessionId]);

  useEffect(() => {
    if (!isTop) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void useChatStore.getState().refresh(sessionId);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [isTop, sessionId]);
}
