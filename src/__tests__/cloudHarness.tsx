// cloudHarness.tsx — the cloud views as ResourcesView composes them (Oct 23 2026), for component
// tests: the cloud session provider around everything, the shared sync-list autoload, the cloud
// tabs (Cloud sync · Projects · Connection) as a plain tab row, CloudPanel, and the cloud action
// dialogs. A test drives it the way a person does: by tab names and buttons.
import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import type { ResourceCatalog } from '@/types/resources';
import CloudPanel, { type CloudSection } from '@/components/resources/cloud/CloudPanel';
import CloudSessionProvider from '@/components/resources/cloud/CloudSessionProvider';
import CloudActionDialogs from '@/components/resources/cloud/CloudActionDialogs';
import { useSyncAutoload } from '@/components/resources/cloud/useSyncAutoload';
import { CATALOG } from '@/__tests__/fixtures/resourceCatalog';

const LABELS: Record<CloudSection, string> = {
  sync: 'Cloud sync',
  projects: 'Projects',
  connection: 'Connection',
};

function Autoload({ catalog }: { catalog: ResourceCatalog }) {
  useSyncAutoload(catalog.scannedAt ?? null);
  return null;
}

export function CloudHarness({
  section: initial = 'sync',
  open = true,
  catalog = CATALOG,
  onShowResource = () => {},
  onLibrary = () => {},
  children,
}: {
  section?: CloudSection;
  /** A cloud tab is the RESOURCES tab in front. */
  open?: boolean;
  catalog?: ResourceCatalog;
  onShowResource?: (catalogId: string) => void;
  onLibrary?: () => void;
  /** Extra content inside the session (a Library control under test). */
  children?: ReactNode;
}) {
  const [section, setSection] = useState<CloudSection>(initial);
  return (
    <MemoryRouter>
      <CloudSessionProvider>
        <Autoload catalog={catalog} />
        <div role="tablist" aria-label="Resource sections">
          {(Object.keys(LABELS) as CloudSection[]).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={s === section}
              onClick={() => setSection(s)}
            >
              {LABELS[s]}
            </button>
          ))}
        </div>
        <CloudPanel
          catalog={catalog}
          section={section}
          open={open}
          onSection={setSection}
          onLibrary={onLibrary}
          onShowResource={onShowResource}
        />
        {children}
        <CloudActionDialogs catalog={catalog} />
      </CloudSessionProvider>
    </MemoryRouter>
  );
}

/** A Library cloud control on its own: the session, the shared autoload and the dialog host around it. */
export function LibraryCloudHarness({
  catalog = CATALOG,
  children,
}: {
  catalog?: ResourceCatalog;
  children: ReactNode;
}) {
  return (
    <MemoryRouter>
      <CloudSessionProvider>
        <Autoload catalog={catalog} />
        {children}
        <CloudActionDialogs catalog={catalog} />
      </CloudSessionProvider>
    </MemoryRouter>
  );
}
