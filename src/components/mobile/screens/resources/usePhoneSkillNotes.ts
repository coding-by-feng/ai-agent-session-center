/**
 * usePhoneSkillNotes — the skill notes (♡, tags, abbreviations) More → Resources shows, read-only
 * (plan 16 P1): the account's notes read through the Mac, merged with this browser's own, as the
 * Chat composer's `/` list reads them (usePhoneCommandIndex).
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchPhoneSkillNotes, mergeNotes } from '@/lib/phoneSuggestions';
import type { SkillNotes } from '@/lib/skillNotes';
import { useSkillNotesStore } from '@/stores/skillNotesStore';

export function usePhoneSkillNotes(): SkillNotes {
  const localNotes = useSkillNotesStore((s) => s.notes);
  const [remoteNotes, setRemoteNotes] = useState<SkillNotes>({});
  useEffect(() => {
    let live = true;
    void fetchPhoneSkillNotes().then((notes) => {
      if (live) setRemoteNotes(notes);
    });
    return () => {
      live = false;
    };
  }, []);
  return useMemo(() => mergeNotes(remoteNotes, localNotes), [remoteNotes, localNotes]);
}
