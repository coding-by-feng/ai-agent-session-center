/**
 * PromptsViewSwitch — List | Days, first in the PROMPTS toolbar of both views (Nov 20 2026),
 * so it never moves when the view changes. One pressed-button pair, like the Source facet.
 */
import Button from '@/components/ui/Button';
import type { PromptsMode } from '@/lib/promptsMode';
import styles from '@/styles/modules/DailyReview.module.css';

export default function PromptsViewSwitch({ mode, onChange }: { mode: PromptsMode; onChange: (mode: PromptsMode) => void }) {
  return (
    <div className={styles.viewSwitch} role="group" aria-label="View">
      <Button pressed={mode === 'list'} onClick={() => onChange('list')} title="Every prompt, newest first">
        List
      </Button>
      <Button pressed={mode === 'days'} onClick={() => onChange('days')} title="One day, by project, room and session">
        Days
      </Button>
    </div>
  );
}
