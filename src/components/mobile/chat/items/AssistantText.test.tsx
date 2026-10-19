// AssistantText.test.tsx — an answer's actions (Oct 20 2026): Copy · Read aloud · Ask AI
// under the latest answer only; an older answer shows them when tapped (or from its
// "Actions for this answer" button, for keyboards and screen readers). Read aloud only
// once Voice is set up on this phone.
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AssistantText from './AssistantText';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AssistantItem } from '@/lib/chat/buildChatItems';

function answer(over: Partial<AssistantItem> = {}): AssistantItem {
  return { kind: 'assistant', key: 'a1', timestamp: 1, text: 'The tests pass now.', truncated: false, isAnswer: true, latestAnswer: true, sig: '', searchText: '', ...over } as AssistantItem;
}

beforeEach(() => {
  useSettingsStore.setState({ ttsEnabled: false, googleTtsApiKey: '' });
});

describe('AssistantText actions', () => {
  it('shows Copy under the latest answer, without Read aloud until Voice is set up', () => {
    render(<AssistantText item={answer()} sessionId="s1" />);
    expect(screen.getByRole('button', { name: 'Copy this answer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Read aloud/ })).toBeNull();
  });

  it('adds Read aloud once Voice is on with a key', () => {
    useSettingsStore.setState({ ttsEnabled: true, googleTtsApiKey: 'AIza-x' });
    render(<AssistantText item={answer()} sessionId="s1" />);
    expect(screen.getByRole('button', { name: /Read aloud/ })).toBeInTheDocument();
  });

  it('hides the actions under an older answer until it is tapped', () => {
    render(<AssistantText item={answer({ latestAnswer: false })} sessionId="s1" />);
    expect(screen.queryByRole('button', { name: 'Copy this answer' })).toBeNull();
    fireEvent.click(screen.getByText('The tests pass now.'));
    expect(screen.getByRole('button', { name: 'Copy this answer' })).toBeInTheDocument();
  });

  it('offers a button for the same, for keyboards and screen readers', () => {
    render(<AssistantText item={answer({ latestAnswer: false })} sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for this answer' }));
    expect(screen.getByRole('button', { name: 'Copy this answer' })).toBeInTheDocument();
  });

  it('gives a reply that is not an answer no actions', () => {
    render(<AssistantText item={answer({ isAnswer: false, latestAnswer: false })} sessionId="s1" />);
    fireEvent.click(screen.getByText('The tests pass now.'));
    expect(screen.queryByRole('button', { name: 'Copy this answer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for this answer' })).toBeNull();
  });
});
