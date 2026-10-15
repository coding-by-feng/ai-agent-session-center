/**
 * LibraryScreen — More → History / Prompt Trace / Review / Agenda (AASC-39
 * placeholder; AASC-47 rebuilds them with the kit). Today's phone views, inside
 * the new screen chrome; they scroll themselves.
 *
 * They were written for the classic layout's router: "Open" in History or
 * Prompts selects a session and navigates to `/`. Here a MemoryRouter (in the
 * frame) swallows the navigation, and the frame's selection bridge turns the
 * selection into "open this session on the Sessions tab".
 */
import { lazy, type ReactNode } from 'react';
import { Screen } from '../kit';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import styles from '@/styles/modules/mobile/Screens.module.css';

const PhoneHistory = lazy(() => import('../views/PhoneHistory'));
const PhonePrompts = lazy(() => import('../views/PhonePrompts'));
const PhoneReview = lazy(() => import('../views/PhoneReview'));
const PhoneAgenda = lazy(() => import('../views/PhoneAgenda'));

export type LibraryPage = 'history' | 'prompts' | 'review' | 'agenda';

const PAGES: Record<LibraryPage, { title: string; view: ReactNode }> = {
  history: { title: 'History', view: <PhoneHistory /> },
  prompts: { title: 'Prompt Trace', view: <PhonePrompts /> },
  review: { title: 'Review', view: <PhoneReview /> },
  agenda: { title: 'Agenda', view: <PhoneAgenda /> },
};

export default function LibraryScreen({ page }: { page: LibraryPage }) {
  const pop = usePhoneNavStore((s) => s.pop);
  const { title, view } = PAGES[page];
  return (
    <Screen title={title} onBack={pop} backLabel="Back to More" scroll={false} testId={`phone-more-${page}`}>
      <div className={styles.embedded}>{view}</div>
    </Screen>
  );
}
