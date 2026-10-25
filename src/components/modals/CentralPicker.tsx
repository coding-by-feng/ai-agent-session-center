/**
 * CentralPicker — the "Central session" field of the two New Session forms: Off, or the scope the new
 * session's central will have (server/mcp). A central is an agent that reads (and later drives) other
 * sessions through AASC's MCP server; one per scope.
 *
 *   Off · Global (every session) · This room (the room picked in the form) · This project (its folder)
 *
 * "This room" and "This project" are offered only when the form has a room or a folder, and a scope that
 * already has a central is greyed out with a hint instead of failing at launch (the live list comes from
 * `mcpStore`). The select shows `effectiveChoice`, so a choice the form no longer supports, or a scope
 * taken since, reads Off, which is what `centralRequestFor` will send. Without a dashboard password, a
 * central can also reach /api directly (the server's rules only bind /mcp), and the field says so.
 *
 * The room's name comes from the room store; the form owns which room and folder it is for.
 */
import { useId } from 'react';
import Field from '@/components/ui/Field';
import NativeSelect, { type NativeSelectOption } from '@/components/ui/NativeSelect';
import { useMcpStore } from '@/stores/mcpStore';
import { useRoomStore } from '@/stores/roomStore';
import {
  centralChoiceHint,
  choiceAvailability,
  effectiveChoice,
  type CentralChoice,
} from '@/lib/centralChoice';
import type { CentralKind } from '@/types';
import styles from '@/styles/modules/CentralPicker.module.css';

export interface CentralPickerProps {
  value: CentralChoice;
  onChange: (value: CentralChoice) => void;
  /** The room the new session will join (the form's own Room field). "This room" is offered only with one. */
  roomId?: string | null;
  /** The folder it starts in. "This project" is offered only with one. */
  folder?: string | null;
  /** Is a dashboard password set? null or undefined while unknown: no warning on a guess. */
  passwordEnabled?: boolean | null;
  /** For the form the picker sits in (its spacing). */
  className?: string;
}

const LABELS: Record<CentralChoice, string> = {
  off: 'Off',
  global: 'Global',
  room: 'This room',
  project: 'This project',
};

const TAKEN_HINTS: Record<CentralKind, string> = {
  global: 'A global central is already running.',
  room: 'A central is already running for this room.',
  project: 'A central is already running for this project.',
};

/** Said without a password: the picker does not hide the setting, it names it. */
export const NO_PASSWORD_WARNING = 'No dashboard password: a central can also reach /api directly.';

const SCOPES: readonly CentralKind[] = ['global', 'room', 'project'];

export default function CentralPicker({
  value,
  onChange,
  roomId,
  folder,
  passwordEnabled,
  className,
}: CentralPickerProps) {
  const id = useId();
  const centrals = useMcpStore((s) => s.centrals);
  const roomName = useRoomStore((s) => (roomId ? s.rooms.find((r) => r.id === roomId)?.name : undefined));

  const ctx = { roomId, folder, centrals };
  const shown = effectiveChoice(value, ctx);
  const availability = SCOPES.map((kind) => [kind, choiceAvailability(kind, ctx)] as const);

  const options: NativeSelectOption<CentralChoice>[] = [
    { value: 'off', label: LABELS.off },
    ...availability
      .filter(([, state]) => state !== 'absent')
      .map(([kind, state]) => ({ value: kind, label: LABELS[kind], disabled: state === 'taken' })),
  ];
  const taken = availability.filter(([, state]) => state === 'taken').map(([kind]) => kind);
  const hint = centralChoiceHint(shown, { roomName, folder });

  const hintId = `${id}-hint`;
  const warningId = `${id}-warning`;
  const describedBy =
    [
      hint ? hintId : null,
      ...taken.map((kind) => `${id}-taken-${kind}`),
      passwordEnabled === false ? warningId : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' ') || undefined;

  return (
    <div className={className ? `${styles.picker} ${className}` : styles.picker}>
      <Field label="Central session" className={styles.field}>
        <NativeSelect
          value={shown}
          onChange={onChange}
          options={options}
          className={styles.select}
          aria-describedby={describedBy}
        />
      </Field>
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {taken.map((kind) => (
        <p key={kind} id={`${id}-taken-${kind}`} className={styles.hint}>
          {TAKEN_HINTS[kind]}
        </p>
      ))}
      {passwordEnabled === false && (
        <p id={warningId} className={styles.warning}>
          {NO_PASSWORD_WARNING}
        </p>
      )}
    </div>
  );
}
