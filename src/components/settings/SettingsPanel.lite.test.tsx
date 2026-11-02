// SettingsPanel.lite.test.tsx — the Lite build keeps APPEARANCE, SOUND and TRANSLATION (lib/edition.ts).
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));
vi.mock('./ThemeSettings', () => ({ default: () => <div>Theme Settings</div> }));
vi.mock('@/components/ui/Modal', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import SettingsPanel from './SettingsPanel';

describe('SettingsPanel in the Lite build', () => {
  it('offers only APPEARANCE, SOUND and TRANSLATION, which holds the AI popup settings', () => {
    render(<SettingsPanel />);
    for (const kept of ['APPEARANCE', 'SOUND', 'TRANSLATION']) expect(screen.getByRole('button', { name: kept })).toBeInTheDocument();
    for (const hidden of ['HOOKS', 'API KEYS', 'SHORTCUTS', 'ADVANCED']) {
      expect(screen.queryByRole('button', { name: hidden })).not.toBeInTheDocument();
    }
  });
});
