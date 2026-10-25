import { describe, it, expect, beforeEach, vi } from 'vitest';
import { activeProjectFile, onOpenFile, postOpenFile } from './projectPopoutFile';

const saveDocked = (sid: string, subTabs: unknown, fileTabs: Record<string, unknown>) => {
  if (subTabs) localStorage.setItem(`agent-manager:project-tabs:session:${sid}`, JSON.stringify(subTabs));
  for (const [id, v] of Object.entries(fileTabs)) {
    localStorage.setItem(`agent-manager:file-tabs:${sid}:${id}`, JSON.stringify(v));
  }
};

describe('activeProjectFile — the file open in the docked PROJECT tab', () => {
  beforeEach(() => localStorage.clear());

  it("reads the active sub-tab's active file", () => {
    saveDocked('s1',
      { tabs: [{ id: 'default', projectPath: '/p' }, { id: 'sub-2', projectPath: '/p' }], active: 'sub-2' },
      {
        default: { tabs: [{ path: 'a.ts', name: 'a.ts' }], active: 'a.ts' },
        'sub-2': { tabs: [{ path: 'src/b.ts', name: 'b.ts' }], active: 'src/b.ts' },
      });
    expect(activeProjectFile('s1', '/p')).toBe('src/b.ts');
  });

  it("falls back to the 'default' sub-tab when no sub-tabs were saved", () => {
    saveDocked('s1', null, { default: { tabs: [{ path: 'a.ts', name: 'a.ts' }], active: 'a.ts' } });
    expect(activeProjectFile('s1', '/p/')).toBe('a.ts');
  });

  it('is undefined when no file is open, the active tab was closed, or another project is shown', () => {
    expect(activeProjectFile('s1', '/p')).toBeUndefined();
    expect(activeProjectFile(undefined, '/p')).toBeUndefined();
    saveDocked('s1', null, { default: { tabs: [], active: 'gone.ts' } });
    expect(activeProjectFile('s1', '/p')).toBeUndefined();
    saveDocked('s2', { tabs: [{ id: 'default', projectPath: '/other' }], active: 'default' },
      { default: { tabs: [{ path: 'a.ts', name: 'a.ts' }], active: 'a.ts' } });
    expect(activeProjectFile('s2', '/p')).toBeUndefined();
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('agent-manager:file-tabs:s1:default', '{not json');
    expect(activeProjectFile('s1', '/p')).toBeUndefined();
  });
});

describe('open-file channel', () => {
  it('delivers a file only to the window for the same project', async () => {
    const forP = vi.fn();
    const forOther = vi.fn();
    const offP = onOpenFile('/p', forP);
    const offOther = onOpenFile('/other', forOther);
    postOpenFile({ projectPath: '/p/', file: 'src/b.ts' });
    await vi.waitFor(() => expect(forP).toHaveBeenCalledWith('src/b.ts'));
    expect(forOther).not.toHaveBeenCalled();
    offP();
    offOther();
  });
});
