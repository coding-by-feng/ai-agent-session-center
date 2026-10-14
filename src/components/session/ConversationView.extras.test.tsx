// ConversationView.extras.test.tsx — the Conversation tab's phone extras (AASC-20): read the last answer
// aloud, and its text is selectable for the AI popup (scoped to this session). None of it on a desktop.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConversationEntry } from '@/lib/transcript';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));
const fetchTranscript = vi.fn<() => Promise<ConversationEntry[]>>();
vi.mock('@/lib/transcript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transcript')>()),
  fetchTranscript: () => fetchTranscript(),
}));
const tts = vi.hoisted(() => ({ speak: vi.fn(async () => {}), stop: vi.fn() }));
vi.mock('@/lib/ttsEngine', () => ({ ttsEngine: tts }));

import { useSettingsStore } from '@/stores/settingsStore';
import ConversationView from './ConversationView';

const T = 1_700_000_000_000;

function renderView() {
  return render(<ConversationView sessionId="s1" prompts={[]} responses={[]} toolCalls={[]} events={[]} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  platform.isMobile = true;
  useSettingsStore.setState({ ttsEnabled: true, googleTtsApiKey: 'user-key-0123456789', translationEnabled: true, translationTrigger: 'auto' });
  fetchTranscript.mockResolvedValue([
    { role: 'user', text: 'what changed?', timestamp: T + 1 },
    { role: 'assistant', text: 'First answer.', timestamp: T + 2 },
    { role: 'assistant', text: '**The** last answer.', timestamp: T + 3 },
  ]);
});

describe('Conversation on a phone', () => {
  it('reads the last assistant answer aloud', async () => {
    renderView();
    await screen.findByText('what changed?');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Read last answer' })); });
    await waitFor(() => expect(tts.speak).toHaveBeenCalledWith('The last answer.', expect.anything()));
  });

  it('marks its text as this session’s, for the AI popup', async () => {
    const { container } = renderView();
    await screen.findByText('what changed?');
    expect(container.querySelector('[data-ai-selectable="s1"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-ai-context]').length).toBeGreaterThan(0);
  });
});

describe('Conversation on a desktop', () => {
  it('has no read-aloud button and no phone selection scope', async () => {
    platform.isMobile = false;
    const { container } = renderView();
    await screen.findByText('what changed?');
    expect(screen.queryByRole('button', { name: 'Read last answer' })).toBeNull();
    expect(container.querySelector('[data-ai-selectable]')).toBeNull();
  });
});
