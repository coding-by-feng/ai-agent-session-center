// RowBadges.test.tsx — a switcher row's second line as pills (Nov 27 2026): read once by a screen reader, as the
// sentence it replaced, and drawn in its tone.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RowBadges from './RowBadges';
import { rowBadges } from '@/lib/remoteComputerBadges';
import type { RemoteComputer, RemoteComputerCheck } from '@/types/electron';

const record: RemoteComputer = {
  id: 'r1', name: 'Mac mini', lan: '192.168.4.30', tailnet: null, port: 3333, status: 'active', confirmCode: null,
  addedAt: 0, lastSeenAt: null, origin: 'link',
};
const online: RemoteComputerCheck = { state: 'online', via: 'public', sharedSessions: 4, needsYou: 2, message: null };

describe('RowBadges', () => {
  it('draws a pill per fact, hidden from screen readers, with the sentence kept for them', () => {
    const b = rowBadges(record, online);
    const { container } = render(<RowBadges badges={b.badges} reason={b.reason} sentence="Online · Public IP, unencrypted · 4 shared · 2 need you" />);
    const pills = [...container.querySelectorAll('[data-tone]')];
    expect(pills.map((p) => `${p.getAttribute('data-tone')}:${p.textContent}`))
      .toEqual(['online:Online', 'warn:Public IP, unencrypted', 'neutral:4 shared', 'warn:2 need you']);
    expect(pills[0].parentElement?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Online · Public IP, unencrypted · 4 shared · 2 need you')).toBeTruthy();
  });

  it('a lone pill that says the whole sentence is the text, read once', () => {
    render(<RowBadges badges={[{ id: 'state', tone: 'offline', label: 'Offline' }]} sentence="Offline" />);
    expect(screen.getAllByText('Offline')).toHaveLength(1);
    expect(screen.getByText('Offline').parentElement?.getAttribute('aria-hidden')).toBeNull();
  });

  it('a reason follows the pills as words', () => {
    render(<RowBadges badges={[{ id: 'state', tone: 'offline', label: 'Offline' }]} reason="No address answered" sentence="Offline: no address answered" />);
    expect(screen.getByText('No address answered')).toBeTruthy();
    expect(screen.getByText('Offline: no address answered')).toBeTruthy();
  });

  it('draws nothing with nothing to say', () => {
    const { container } = render(<RowBadges badges={[]} sentence="" />);
    expect(container.innerHTML).toBe('');
  });
});
