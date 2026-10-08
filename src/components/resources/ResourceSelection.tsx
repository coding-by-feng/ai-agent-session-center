import { useEffect, useRef, useState } from 'react';
import type { ResourceProject, ResourceSummary } from '@/types/resources';
import { RESOURCE_TYPES } from '@/types/resources';
import {
  matchesResourceSelector,
  resourceIsSelected,
  withResourceSelection,
  transferBlocker,
  type ResourceSelection as Selection,
  type ResourceSelector,
} from '@/types/resourceTransfers';
import { AGENT_LABELS, RESOURCE_TYPE_LABELS } from '@/lib/resourceFilters';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import { isNotable, noteForResource, passesNoteFilter, tagsInUse, type NoteFilter } from '@/lib/skillNotes';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import NativeSelect from '@/components/ui/NativeSelect';
import styles from '@/styles/modules/ResourceTransfers.module.css';

export function SelectionCheck({
  label,
  checked,
  mixed = false,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <label className={styles.check}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        aria-checked={mixed ? 'mixed' : checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export default function ResourceSelection({
  resources,
  projects,
  selection,
  onChange,
}: {
  resources: ResourceSummary[];
  projects: ResourceProject[];
  selection: Selection;
  onChange: (selection: Selection) => void;
}) {
  const [agent, setAgent] = useState<'all' | 'claude' | 'codex' | 'shared'>('all');
  const selected = new Set(
    resources.filter((r) => resourceIsSelected(r, selection)).map((r) => r.id),
  );
  const agentSelector = agent === 'all' ? {} : { agent };
  // The user's own marks (this browser): a favourite or a tag picks resources by id.
  const notes = useSkillNotesStore((s) => s.notes);
  const noteRows = (filter: NoteFilter, scoped = true) =>
    resources.filter((r) =>
      (!scoped || matchesResourceSelector(r, agentSelector)) && isNotable(r) && passesNoteFilter(noteForResource(notes, r), filter),
    );
  function noteGroup(label: string, filter: NoteFilter) {
    const rows = noteRows(filter);
    const count = rows.filter((r) => selected.has(r.id)).length;
    return (
      <SelectionCheck
        key={label}
        label={`${label} (${count}/${rows.length})`}
        checked={rows.length > 0 && count === rows.length}
        mixed={count > 0 && count < rows.length}
        disabled={rows.length === 0}
        onChange={(include) =>
          onChange(withResourceSelection(selection, rows.map((r) => ({ resourceId: r.id, include }))))
        }
      />
    );
  }
  const markedTags = tagsInUse(notes).filter(({ tag }) => noteRows({ tags: [tag] }, false).length > 0);
  const anyFavourite = noteRows({ favOnly: true }, false).length > 0;
  function group(label: string, selector: ResourceSelector) {
    const match = { ...selector, ...agentSelector };
    const rows = resources.filter((r) => matchesResourceSelector(r, match));
    const count = rows.filter((r) => selected.has(r.id)).length;
    return (
      <SelectionCheck
        label={`${label} (${count}/${rows.length})`}
        checked={rows.length > 0 && count === rows.length}
        mixed={count > 0 && count < rows.length}
        onChange={(include) => onChange(withResourceSelection(selection, [{ ...match, include }]))}
      />
    );
  }
  const scopes: { label: string; selector: ResourceSelector }[] = [
    { label: 'Global resources', selector: { scope: 'global' } },
    { label: 'All projects', selector: { scope: 'project' } },
  ];
  const types = (scope: ResourceSelector) =>
    RESOURCE_TYPES.map((type) => {
      const rows = resources.filter((r) =>
        matchesResourceSelector(r, { ...scope, ...agentSelector, type }),
      );
      if (!rows.length) return null;
      return (
        <details key={type} className={styles.branch}>
          <summary>
            {RESOURCE_TYPE_LABELS[type]} · {rows.filter((r) => selected.has(r.id)).length}/
            {rows.length}
          </summary>
          {group(`All ${RESOURCE_TYPE_LABELS[type].toLowerCase()}`, { ...scope, type })}
          <div className={styles.leaves}>
            {rows.map((r) => (
              <div key={r.id}>
                <SelectionCheck
                  label={`${r.name} · ${AGENT_LABELS[r.agent]}`}
                  checked={selected.has(r.id)}
                  onChange={(include) =>
                    onChange(withResourceSelection(selection, [{ resourceId: r.id, include }]))
                  }
                />
                {transferBlocker(r) && (
                  <small className={styles.hint}>Review required: {transferBlocker(r)}</small>
                )}
              </div>
            ))}
          </div>
        </details>
      );
    });
  return (
    <div className={styles.selection}>
      <div className={styles.toolbar}>
        <Field label="Agent selection">
          <NativeSelect
            value={agent}
            onChange={setAgent}
            options={[
              { value: 'all', label: 'All agents' },
              { value: 'claude', label: 'Claude' },
              { value: 'codex', label: 'Codex' },
              { value: 'shared', label: 'Shared' },
            ]}
          />
        </Field>
        <Button size="sm" onClick={() => onChange([])}>
          Clear selection
        </Button>
      </div>
      <p className={styles.hint}>
        Choose a scope, project or type, then uncheck individual exceptions. Selections stay when
        you change the agent filter. Group rules include future resources on the next comparison.
      </p>
      {group('All resources', {})}
      {(anyFavourite || markedTags.length > 0) && (
        <details className={styles.branch} open>
          <summary>By my notes</summary>
          {anyFavourite && noteGroup('Favourites', { favOnly: true })}
          {markedTags.map(({ tag }) => noteGroup(`Tag ${tag}`, { tags: [tag] }))}
          <small className={styles.hint}>
            Ticking one selects the items marked now, by name; items you mark later are not added.
          </small>
        </details>
      )}
      {scopes.map(({ label, selector }) => (
        <details key={label} className={styles.branch} open>
          <summary>{label}</summary>
          {group(`Select ${label.toLowerCase()}`, selector)}
          {selector.scope === 'global' ? (
            types(selector)
          ) : (
            <>
              <details className={styles.branch}>
                <summary>By type across projects</summary>
                {types(selector)}
              </details>
              {projects.map((p) => (
                <details key={p.id} className={styles.branch}>
                  <summary>
                    {p.name} <span className={styles.hint}>{p.path}</span>
                  </summary>
                  {group(`Project ${p.name}`, { scope: 'project', projectId: p.id })}
                  {types({ scope: 'project', projectId: p.id })}
                </details>
              ))}
            </>
          )}
        </details>
      ))}
      <p role="status">
        {selected.size} selected ·{' '}
        {resources.filter((r) => selected.has(r.id) && transferBlocker(r)).length} require review
      </p>
    </div>
  );
}
