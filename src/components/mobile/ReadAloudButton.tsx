/**
 * ReadAloudButton — speak the agent's last answer on a phone (AASC-20). A 44px
 * toggle: "Read aloud" starts, "Stop" stops; the words change with the state, so
 * it never rests on colour. See useReadAloud for the key and the one-voice rule.
 */
import { useReadAloud } from '@/hooks/useReadAloud';
import { SpeakerIcon, StopIcon } from './phoneIcons';
import styles from '@/styles/modules/PhoneExtras.module.css';

export interface ReadAloudButtonProps {
  /** Which button this is (see useReadAloud). */
  speakKey: string;
  /** The text to read, fetched at the moment of the tap. */
  source: () => string | Promise<string>;
  label?: string;
}

export default function ReadAloudButton({ speakKey, source, label = 'Read aloud' }: ReadAloudButtonProps) {
  const { speaking, toggle } = useReadAloud(speakKey);
  return (
    <button
      type="button"
      className={styles.speakBtn}
      aria-pressed={speaking}
      onClick={() => toggle(source)}
    >
      {speaking ? <StopIcon /> : <SpeakerIcon />}
      <span>{speaking ? 'Stop' : label}</span>
    </button>
  );
}
