/**
 * LibraryScreen — More → History / Prompt Trace / Saved prompts / Review /
 * Agenda (AASC-47). Each is a pushed screen with today's phone view inside
 * (AASC-20: one column, search on top, filters in a sheet, a row opens full
 * screen); they scroll themselves. Saved prompts is new on the phone.
 *
 * The views were written for the classic layout's router: "Open" in History or
 * Prompts selects a session and navigates to `/`. Here a MemoryRouter (in the
 * frame) swallows the navigation, and the frame's selection bridge turns the
 * selection into "open this session on the Sessions tab".
 */
import { lazy, Suspense, type ReactNode } from 'react';
import { EmptyState, Screen } from '../kit';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import styles from '@/styles/modules/mobile/Screens.module.css';

const PhoneHistory = lazy(() => import('../views/PhoneHistory'));
const PhonePrompts = lazy(() => import('../views/PhonePrompts'));
const PhoneReview = lazy(() => import('../views/PhoneReview'));
const PhoneAgenda = lazy(() => import('../views/PhoneAgenda'));
const SavedPromptsView = lazy(() => import('./SavedPromptsView'));

export type LibraryPage = 'history' | 'prompts' | 'saved-prompts' | 'review' | 'agenda';

const PAGES: Record<LibraryPage, { title: string; view: ReactNode; embedded: boolean }> = {
  history: { title: 'History', view: <PhoneHistory />, embedded: true },
  prompts: { title: 'Prompt Trace', view: <PhonePrompts />, embedded: true },
  'saved-prompts': { title: 'Saved prompts', view: <SavedPromptsView />, embedded: false },
  review: { title: 'Review', view: <PhoneReview />, embedded: true },
  agenda: { title: 'Agenda', view: <PhoneAgenda />, embedded: true },
};

export default function LibraryScreen({ page }: { page: LibraryPage }) {
  const pop = usePhoneNavStore((s) => s.pop);
  const { title, view, embedded } = PAGES[page];
  const body = <Suspense fallback={<EmptyState live title="Loading…" />}>{view}</Suspense>;
  return (
    <Screen title={title} onBack={pop} backLabel="Back to More" scroll={!embedded} testId={`phone-more-${page}`}>
      {embedded ? <div className={styles.embedded}>{body}</div> : body}
    </Screen>
  );
}
