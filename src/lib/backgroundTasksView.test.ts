import { describe, it, expect } from 'vitest';
import type { BackgroundItem, BackgroundTasks } from '@/types/session';
import { backgroundSummary, hiddenCount, backgroundTitle, backgroundKind, isRunning } from './backgroundTasksView';

const list = (over: Partial<BackgroundTasks>): BackgroundTasks => ({ items: [], agents: 0, shells: 0, activeShells: 0, at: 1, ...over });
const item = (over: Partial<BackgroundItem>): BackgroundItem => ({ id: 'x1', type: 'shell', status: 'running', description: null, command: null, firstSeenAt: 1, ...over });

describe('backgroundSummary', () => {
  it('reads like Claude Code’s own panel', () => {
    expect(backgroundSummary(list({ agents: 82, shells: 1, activeShells: 1 }))).toBe('82 agents · 1 active shell');
    expect(backgroundSummary(list({ agents: 1 }))).toBe('1 agent');
    expect(backgroundSummary(list({ shells: 2 }))).toBe('2 shells');
    expect(backgroundSummary(list({ shells: 3, activeShells: 2 }))).toBe('2 active shells');
    expect(backgroundSummary(list({}))).toBe('Nothing running');
  });
});

describe('hiddenCount', () => {
  it('is what the cap left out', () => {
    expect(hiddenCount(list({ agents: 82, shells: 1, items: Array.from({ length: 50 }, () => item({})) }))).toBe(33);
    expect(hiddenCount(list({ agents: 1, items: [item({})] }))).toBe(0);
  });
});

describe('row text', () => {
  it('prefers the description, then the command, then the id', () => {
    expect(backgroundTitle(item({ description: 'Wait for report', command: 'until …' }))).toBe('Wait for report');
    expect(backgroundTitle(item({ command: 'npm run dev' }))).toBe('npm run dev');
    expect(backgroundTitle(item({}))).toBe('x1');
  });
  it('labels the kind and knows running from finished', () => {
    expect(backgroundKind(item({ type: 'teammate' }))).toBe('Teammate');
    expect(isRunning(item({ status: '' }))).toBe(true);
    expect(isRunning(item({ status: 'completed' }))).toBe(false);
  });
});
