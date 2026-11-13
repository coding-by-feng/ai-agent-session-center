// cloudHarness.tsx — the cloud session as ResourcesView provides it (Nov 13 2026), for component
// tests of what lives inside it: Projects (CloudPanel), the cloud account dialog's panel and
// Machines. Cloud sync and its Library controls were removed, and with them the shared sync-list
// autoload and the action dialogs this harness used to mount.
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import CloudSessionProvider from '@/components/resources/cloud/CloudSessionProvider';

export function CloudHarness({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <CloudSessionProvider>{children}</CloudSessionProvider>
    </MemoryRouter>
  );
}
