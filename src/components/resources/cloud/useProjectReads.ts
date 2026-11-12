/**
 * useProjectReads — the Projects tab's reads of each saved checkout on this Mac, then its GitHub
 * checks (code review, Oct 29 2026). Checkouts are read a few at a time once the list shows, so a
 * slow or broken folder holds no button and blanks nothing: its row says what went wrong. Then
 * each saved checkout is checked with GitHub, one at a time; the server skips a project fetched in
 * the last 10 minutes. A row's own action (Link, account, Check now, a job ending) outranks a read
 * or check that started before it.
 */
import { useEffect, useRef, useState } from 'react';
import type { LocalProject, ProjectRecord } from '@/types/cloudProjects';
import { cloudApi, type CloudReviewBinding } from '@/lib/cloudApi';
import { projectStatus } from './projectState';
import { cloudError } from './cloudSession';

/** Checkouts read at once: each read runs Git on this Mac. */
const READS_AT_ONCE = 4;
const without = <T>(record: Record<string, T>, id: string) => {
  const next = { ...record };
  delete next[id];
  return next;
};

/** `skip`: projects with a running Clone, Pull or Push, which the checks pass by. */
export function useProjectReads(skip: () => ReadonlySet<string>) {
  const [locals, setLocals] = useState<Record<string, LocalProject>>({}),
    [reading, setReading] = useState<ReadonlySet<string>>(new Set()),
    [checking, setChecking] = useState<string | null>(null),
    [errors, setErrors] = useState<Record<string, string>>({});
  const run = useRef<AbortController | null>(null);
  /** Each project's own writes, counted: a read or check from before the latest doesn't land. */
  const writes = useRef(new Map<string, number>());
  const turn = (id: string) => writes.current.get(id) ?? 0;
  useEffect(() => {
    const runs = run;
    return () => runs.current?.abort();
  }, []);

  function land(id: string, l: LocalProject) {
    setLocals((old) => ({ ...old, [id]: l }));
    setErrors((e) => without(e, id));
  }
  function fail(id: string, message: string) {
    setErrors((e) => ({ ...e, [id]: message }));
  }
  /** Read each checkout, then (`check`) ask GitHub about each one that can be checked. */
  function readAll(
    list: readonly ProjectRecord[],
    binding: CloudReviewBinding,
    { check }: { check: boolean },
  ) {
    run.current?.abort();
    const c = new AbortController();
    run.current = c;
    const live = () => !c.signal.aborted;
    setReading(new Set(list.map((p) => p.id)));
    setChecking(null);
    void (async () => {
      const read: Record<string, LocalProject> = {};
      let next = 0;
      const worker = async () => {
        while (live() && next < list.length) {
          const id = list[next++].id,
            mine = turn(id);
          try {
            const l = await cloudApi.localProject(id, binding, c.signal);
            read[id] = l;
            if (live() && turn(id) === mine) land(id, l);
          } catch (err) {
            if (live() && turn(id) === mine) fail(id, `Couldn’t read its folder: ${cloudError(err)}`);
          }
          if (live())
            setReading((r) => {
              const left = new Set(r);
              left.delete(id);
              return left;
            });
        }
      };
      await Promise.all(Array.from({ length: READS_AT_ONCE }, worker));
      if (!check) return;
      for (const p of list) {
        if (!live()) return;
        if (!projectStatus(read[p.id], p.repository.branch).check || skip().has(p.id)) continue;
        const mine = turn(p.id);
        setChecking(p.id);
        try {
          const l = await cloudApi.checkProject(p.id, binding, c.signal, true);
          if (live() && turn(p.id) === mine) land(p.id, l);
        } catch (err) {
          if (live() && turn(p.id) === mine) fail(p.id, `Couldn’t check GitHub: ${cloudError(err)}`);
        }
      }
      if (live()) setChecking(null);
    })();
  }
  return {
    locals,
    /** Saved projects whose checkout is being read. */
    reading,
    /** The saved project being checked with GitHub now. */
    checking,
    /** Why a project's read or check failed. */
    errors,
    readAll,
    /** A row's own action starts: what it answers is the project's state, not an older read. */
    mine(id: string) {
      writes.current.set(id, turn(id) + 1);
      return (l: LocalProject) => land(id, l);
    },
    /** Another account or connection: stop, and forget what was read. */
    reset() {
      run.current?.abort();
      writes.current = new Map();
      setLocals({});
      setReading(new Set());
      setChecking(null);
      setErrors({});
    },
  };
}
