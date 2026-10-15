/** Isolated acceptance surface: actual Library note controls and autocomplete helpers. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import SkillNotes from '../../src/components/resources/SkillNotes';
import {
  useSkillNotesStore,
  refreshNotesConnection,
  startNotesSync,
} from '../../src/stores/skillNotesStore';
import { passesNoteFilter } from '../../src/lib/skillNotes';
import { filterAndGroup } from '../../src/lib/commandIndex';
const resource = { agent: 'claude' as const, type: 'skill' as const, name: 'browser-fixture' };
function Fixture() {
  const notes = useSkillNotesStore((s) => s.notes),
    sync = useSkillNotesStore((s) => s.sync);
  return (
    <main>
      <h1>Isolated notes acceptance fixture</h1>
      <SkillNotes resource={resource} realNames={new Set(['claude:browser-fixture'])} />
      <p data-testid="library">
        {passesNoteFilter(notes['claude:browser-fixture'] ?? null, {
          favOnly: true,
          tags: ['offline'],
        })
          ? 'Library filter matches'
          : 'No filter match'}
      </p>
      <p data-testid="autocomplete">
        {filterAndGroup(
          [
            {
              name: resource.name,
              description: 'Fixture',
              cli: 'claude',
              kind: 'skill',
              source: 'global',
            },
          ],
          'bf',
          'skill',
          notes,
        )
          .flatMap((g) => g.entries)
          .map((e) => e.name)
          .join(',')}
      </p>
      <pre data-testid="sync">{JSON.stringify(sync)}</pre>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
let started = false;
Object.assign(window, {
  notesHarness: {
    store: useSkillNotesStore,
    connect: async () => {
      if (!started) {
        started = true;
        startNotesSync();
      }
      await refreshNotesConnection();
    },
  },
});
