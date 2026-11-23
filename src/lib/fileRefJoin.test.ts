// fileRefJoin.test.ts — a path split across two terminal lines (Nov 23 2026). The lines are Codex's own output.
import { describe, it, expect } from 'vitest';
import { findJoinedRef } from './fileRefJoin';

describe('findJoinedRef', () => {
  it('joins a CJK file name Codex broke onto an indented line', () => {
    const upper = '• 播放首版（06-ai/ai-video/assets/2026-11-23-01-math-video-skills-and-storytelling/黎曼猜想-验过10';
    const lower = '  万亿个零点为什么还要证明.mp4）';
    const ref = findJoinedRef(upper, lower)!;
    expect(ref.text).toBe('06-ai/ai-video/assets/2026-11-23-01-math-video-skills-and-storytelling/黎曼猜想-验过10万亿个零点为什么还要证明.mp4');
    expect(upper.slice(ref.upperStart, ref.upperEnd)).toBe('06-ai/ai-video/assets/2026-11-23-01-math-video-skills-and-storytelling/黎曼猜想-验过10');
    expect(lower.slice(ref.lowerStart, ref.lowerEnd)).toBe('万亿个零点为什么还要证明.mp4');
  });

  it('joins a path broken after a hyphen, and stops at the closing bracket', () => {
    const ref = findJoinedRef(
      '  了核查深度。逐字稿（06-ai/ai-video/assets/2026-11-23-01-math-video-skills-   ',
      '  and-storytelling/逐字稿.txt）· 可编辑制作包（06-ai/x/可编辑制作包.zip）',
    )!;
    expect(ref.text).toBe('06-ai/ai-video/assets/2026-11-23-01-math-video-skills-and-storytelling/逐字稿.txt');
  });

  it('joins an `ls -l` row whose file name wrapped', () => {
    const ref = findJoinedRef('-rw-r--r--@ 1 me  staff  1.8M Nov 23 18:34 06-ai/assets/黎曼猜想-验过10万亿', '  个零点为什么还要证明.mp4')!;
    expect(ref.text).toBe('06-ai/assets/黎曼猜想-验过10万亿个零点为什么还要证明.mp4');
  });

  it('joins a soft wrap (no indent)', () => {
    expect(findJoinedRef('see src/components/sess', 'ion/DetailPanel.tsx for it')?.text).toBe('src/components/session/DetailPanel.tsx');
  });

  it('nothing when the upper line ends in prose or in a finished path, or a line is empty', () => {
    expect(findJoinedRef('Done.', '  docs/plan.md')).toBeNull();
    expect(findJoinedRef('see docs/plan.md', '  and more')).toBeNull();
    expect(findJoinedRef('see docs/plan.md', 'notes.md')).toBeNull();
    expect(findJoinedRef('a line', '')).toBeNull();
    expect(findJoinedRef('', 'docs/plan.md')).toBeNull();
  });
});
