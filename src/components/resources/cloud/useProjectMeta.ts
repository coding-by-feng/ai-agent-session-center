/**
 * useProjectMeta — the Projects tab's ♥ and tag changes (code review, Oct 29 2026). Each project's
 * changes go to AASC Cloud one at a time, in the order they were made, so a quick on/off can't
 * land out of order. A row shows the cloud's last answer with the changes still on their way; a
 * refused change drops out, so a row never keeps a state the cloud never saved.
 */
import { useRef, useState } from 'react';
import type { ProjectMeta, ProjectMetaChange } from '@/types/cloudProjects';
import { cloudApi, type CloudReviewBinding } from '@/lib/cloudApi';
import { cloudError } from './cloudSession';

export function useProjectMeta({
  isCurrent,
  onAnswer,
  onError,
}: {
  /** The account (and connection) a change was made under is still the tab's. */
  isCurrent: (epoch: number) => boolean;
  /** The cloud saved a change: its answer for that project. */
  onAnswer: (id: string, meta: ProjectMeta) => void;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState<Record<string, readonly ProjectMetaChange[]>>({});
  const queues = useRef(new Map<string, readonly ProjectMetaChange[]>());
  /** One sender per project; a reset gives the next change a new one. */
  const senders = useRef(new Map<string, symbol>());

  function put(id: string, changes: readonly ProjectMetaChange[]) {
    if (changes.length) queues.current.set(id, changes);
    else queues.current.delete(id);
    setPending((old) => {
      const next = { ...old };
      if (changes.length) next[id] = changes;
      else delete next[id];
      return next;
    });
  }
  async function send(id: string, binding: CloudReviewBinding, epoch: number) {
    const me = Symbol(id);
    senders.current.set(id, me);
    const mine = () => senders.current.get(id) === me && isCurrent(epoch);
    try {
      for (let next = queues.current.get(id)?.[0]; next; next = queues.current.get(id)?.[0]) {
        try {
          const meta = await cloudApi.changeProjectMeta(id, next, binding);
          if (!mine()) return;
          onAnswer(id, meta);
        } catch (err) {
          if (!mine()) return;
          onError(cloudError(err));
        }
        put(id, (queues.current.get(id) ?? []).slice(1));
      }
    } finally {
      if (senders.current.get(id) === me) senders.current.delete(id);
    }
  }
  return {
    pending,
    change(id: string, change: ProjectMetaChange, binding: CloudReviewBinding, epoch: number) {
      put(id, [...(queues.current.get(id) ?? []), change]);
      if (!senders.current.has(id)) void send(id, binding, epoch);
    },
    /** Another account or connection: the changes on their way no longer show or land. */
    reset() {
      queues.current = new Map();
      senders.current = new Map();
      setPending({});
    },
  };
}
