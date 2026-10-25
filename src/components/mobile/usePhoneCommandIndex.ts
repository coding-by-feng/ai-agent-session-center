/**
 * usePhoneCommandIndex — this CLI's commands and skills (the Mac's `/api/commands`)
 * and the skill notes that rank them (favourites and abbreviations read through
 * the Mac, merged with this browser's own), for the phone's suggestion bar and
 * the Chat composer's list. Nothing is fetched until `wanted`: a box never typed
 * into asks for nothing.
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchCommandIndex, type CommandEntry } from '@/lib/commandIndex';
import { fetchPhoneSkillNotes, mergeNotes } from '@/lib/phoneSuggestions';
import type { SkillNotes } from '@/lib/skillNotes';
import { useSkillNotesStore } from '@/stores/skillNotesStore';

export function usePhoneCommandIndex(
  cli: 'claude' | 'codex',
  projectPath: string | null,
  wanted: boolean,
): { entries: CommandEntry[]; notes: SkillNotes } {
  const localNotes = useSkillNotesStore((s) => s.notes);
  const [remoteNotes, setRemoteNotes] = useState<SkillNotes>({});
  const [index, setIndex] = useState<{ key: string; entries: CommandEntry[] }>({ key: '', entries: [] });
  const indexKey = `${cli}|${projectPath ?? ''}`;

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void fetchPhoneSkillNotes().then((notes) => {
      if (live) setRemoteNotes(notes);
    });
    return () => {
      live = false;
    };
  }, [wanted]);

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void fetchCommandIndex(cli, projectPath).then((entries) => {
      if (live) setIndex({ key: indexKey, entries });
    });
    return () => {
      live = false;
    };
  }, [wanted, cli, projectPath, indexKey]);

  const notes = useMemo(() => mergeNotes(remoteNotes, localNotes), [remoteNotes, localNotes]);
  const entries = useMemo(() => (index.key === indexKey ? index.entries : []), [index, indexKey]);
  return { entries, notes };
}
