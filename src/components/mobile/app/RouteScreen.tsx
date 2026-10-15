/**
 * RouteScreen — which screen draws which path (AASC-39).
 *
 * To add a screen: give it a path in lib/chat/phoneRoutes.ts (the parse and the
 * build, plus `pathChain` if it has a parent other than its tab's root), draw it
 * here, and push it with `usePhoneNavStore.getState().push(path)`. The tab roots
 * and the session screen load with the frame; the rest load on first use.
 */
import { lazy } from 'react';
import { parsePhonePath } from '@/lib/chat/phoneRoutes';
import SessionsScreen from '../screens/SessionsScreen';
import SessionScreen from '../screens/SessionScreen';
import InboxScreen from '../screens/InboxScreen';
import QueueScreen from '../screens/QueueScreen';
import MoreScreen from '../screens/MoreScreen';
import { EmptyState, Screen } from '../kit';

const LibraryScreen = lazy(() => import('../screens/LibraryScreen'));
const SettingsScreen = lazy(() => import('../screens/SettingsScreen'));
const AboutScreen = lazy(() => import('../screens/AboutScreen'));
const InfoScreen = lazy(() => import('../screens/InfoScreen'));
const InfoPageScreen = lazy(() => import('../screens/info/InfoPageScreen'));
const GalleryScreen = lazy(() => import('../screens/GalleryScreen'));

function UnknownScreen() {
  return (
    <Screen title="Not found">
      <EmptyState title="This screen doesn’t exist" />
    </Screen>
  );
}

export default function RouteScreen({ path }: { path: string }) {
  const route = parsePhonePath(path);
  if (!route) return <UnknownScreen />;
  if (route.kind === 'session') return <SessionScreen sessionId={route.sessionId} segment={route.segment} />;
  if (route.kind === 'session-info') {
    return route.page
      ? <InfoPageScreen sessionId={route.sessionId} page={route.page} />
      : <InfoScreen sessionId={route.sessionId} />;
  }
  if (route.kind === 'tab-root') {
    if (route.tab === 'sessions') return <SessionsScreen />;
    if (route.tab === 'inbox') return <InboxScreen />;
    if (route.tab === 'queue') return <QueueScreen />;
    return <MoreScreen />;
  }
  switch (route.page) {
    case 'settings': return <SettingsScreen />;
    case 'about': return <AboutScreen />;
    case 'gallery': return <GalleryScreen />;
    default: return <LibraryScreen page={route.page} />;
  }
}
