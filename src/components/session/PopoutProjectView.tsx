/**
 * PopoutProjectView — the entire renderer when this window is a popped-out
 * PROJECT tab (Electron, loaded as `/?popout=project&path=…`).
 *
 * It is the project-tab counterpart to PopoutTerminalView: a lightweight window
 * that hosts just the file tree + viewer, NOT the full dashboard. It wraps the
 * existing standalone `ProjectBrowserView` (which reads `?path=`/`?file=` from
 * the query string) and adds the settings + WebSocket init that the full <App>
 * would normally provide — so the popup gets the user's theme and a populated
 * sessions store (used to resolve the select-to-translate origin session).
 *
 * This replaces the old `⧉` behaviour of opening the `/project-browser` route
 * inside a fresh <App> boot ("another chrome instance").
 */
import { useWebSocket } from '@/hooks/useWebSocket';
import { useSettingsInit } from '@/hooks/useSettingsInit';
import ProjectBrowserView from '@/routes/ProjectBrowserView';
import FileOpenChooser from '@/components/session/FileOpenChooser';

export default function PopoutProjectView() {
  useSettingsInit();
  // Auth tokens aren't carried into the popout window — localhost Electron runs
  // without auth. (Password-protected setups would need token plumbing here.)
  useWebSocket(null);

  return (
    <>
      <ProjectBrowserView />
      <FileOpenChooser />
    </>
  );
}
