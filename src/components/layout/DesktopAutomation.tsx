/**
 * DesktopAutomation — work only the desktop does for everyone (AASC-17).
 *
 * Saving and restoring the shared workspace, and firing the shared prompt
 * queue. Not mounted in the phone app: iOS freezes a backgrounded page mid-send,
 * and the one restore claim and one workspace writer per server belong to the
 * desktop. A component rather than a conditional hook call, so the rules of
 * hooks hold.
 */
import { useWorkspaceAutoSave } from '@/hooks/useWorkspaceAutoSave';
import { useWorkspaceAutoLoad } from '@/hooks/useWorkspaceAutoLoad';
import { useGlobalQueueScheduler } from '@/hooks/useGlobalQueueScheduler';
import { isNativeMobileApp } from '@/lib/platform';

function DesktopAutomation() {
  useWorkspaceAutoSave();
  useWorkspaceAutoLoad();
  useGlobalQueueScheduler();
  return null;
}

export default function DesktopAutomationGate() {
  return isNativeMobileApp() ? null : <DesktopAutomation />;
}
