// phoneViews.test.tsx — which view a route draws on a phone (AASC-20).
//
// HISTORY, PROMPTS, REVIEW and AGENDA each switch to their one-column phone
// view under useIsMobile() (a SIZE decision, src/lib/platform.ts) and keep the
// desktop view otherwise; the desktop views' own suites cover that side. The
// AGENDA tab, desktop-only until now, shows in a phone's nav row.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));
vi.mock('@/components/mobile/views/PhoneHistory', () => ({ default: () => <div data-testid="phone-view">history</div> }));
vi.mock('@/components/mobile/views/PhonePrompts', () => ({ default: () => <div data-testid="phone-view">prompts</div> }));
vi.mock('@/components/mobile/views/PhoneReview', () => ({ default: () => <div data-testid="phone-view">review</div> }));
vi.mock('@/components/mobile/views/PhoneAgenda', () => ({ default: () => <div data-testid="phone-view">agenda</div> }));
vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'me', getClientLabel: () => 'Phone' }));

import HistoryView from './HistoryView';
import PromptsView from './PromptsView';
import ReviewView from './ReviewView';
import AgendaView from './AgendaView';
import NavBar from '@/components/layout/NavBar';

beforeEach(() => {
  platform.isMobile = true;
});

describe('routes on a phone', () => {
  it.each([
    ['HISTORY', HistoryView, 'history'],
    ['PROMPTS', PromptsView, 'prompts'],
    ['REVIEW', ReviewView, 'review'],
    ['AGENDA', AgendaView, 'agenda'],
  ])('%s draws its phone view', (_name, View, text) => {
    render(<MemoryRouter><View /></MemoryRouter>);
    expect(screen.getByTestId('phone-view').textContent).toBe(text);
  });

  it('lists AGENDA in the nav row on a phone', () => {
    render(<MemoryRouter><NavBar /></MemoryRouter>);
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['LIVE', 'AGENDA', 'HISTORY', 'PROMPTS', 'QUEUE', 'REVIEW']);
  });
});
