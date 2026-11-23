// terminalFileLinks.test.ts — the terminal's file links on a real (headless) xterm buffer, with Codex's own
// wrapped output (Nov 23 2026): a path split across two lines links as one, across both lines, with CJK columns.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import headless from '@xterm/headless';
import type { ILink } from '@xterm/xterm';
import { fileLinkProvider, type LinkTerminal } from './terminalFileLinks';

const exists = new Set<string>();
vi.mock('./fileRefResolve', () => ({
  resolveFileRef: vi.fn(async (text: string, _kind: string, ctx: { projectPath: string }) => {
    const absolute = text.startsWith('/') ? text : `${ctx.projectPath}/${text}`;
    return exists.has(absolute) ? { kind: 'file', absolute } : null;
  }),
}));

const ROOT = '/Users/me/second-brain';
const MP4 = '06-ai/assets/黎曼猜想-验过10万亿个零点为什么还要证明.mp4';

async function termWith(lines: string[]) {
  const term = new headless.Terminal({ cols: 60, rows: 20, allowProposedApi: true });
  await new Promise<void>((done) => term.write(lines.join('\r\n'), done));
  return term;
}

function linksOn(term: InstanceType<typeof headless.Terminal>, y: number, open = vi.fn()) {
  const provider = fileLinkProvider(term as unknown as LinkTerminal, { projectPath: () => ROOT, open });
  return new Promise<ILink[]>((done) => provider.provideLinks(y, (links) => done(links ?? [])));
}

describe('fileLinkProvider', () => {
  beforeEach(() => exists.clear());

  it('links a path Codex broke onto an indented line as one link, from either half', async () => {
    exists.add(`${ROOT}/${MP4}`);
    const term = await termWith(['• 播放首版（06-ai/assets/黎曼猜想-验过10', '  万亿个零点为什么还要证明.mp4）', 'Worked for 7m']);
    for (const y of [1, 2]) {
      const links = await linksOn(term, y);
      expect(links.map((l) => l.text), `line ${y}`).toEqual([MP4]);
      // Starts after "• 播放首版（" (1 + 1 + 4×2 + 2 = 12 columns) on line 1, ends after ".mp4" on line 2.
      expect(links[0].range).toEqual({ start: { x: 13, y: 1 }, end: { x: 2 + 12 * 2 + 4, y: 2 } });
    }
  });

  it('opens the whole file, and drops the half that matched on its own', async () => {
    const txt = '06-ai/assets/2026-math-video-skills-and-storytelling/逐字稿.txt';
    exists.add(`${ROOT}/${txt}`);
    const term = await termWith(['逐字稿（06-ai/assets/2026-math-video-skills-', '  and-storytelling/逐字稿.txt）· 包（06-ai/x/包.zip）']);
    const open = vi.fn();
    const links = await linksOn(term, 2, open);
    expect(links.map((l) => l.text)).toEqual(['06-ai/x/包.zip', txt]);
    links[1].activate(new MouseEvent('click'), links[1].text);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ projectPath: ROOT, filePath: txt }), expect.anything());
  });

  it('a joined path that does not exist links nothing new; one-line links stay', async () => {
    const term = await termWith(['see 06-ai/notes/draft-', '  and-more/x.md here']);
    expect((await linksOn(term, 2)).map((l) => l.text)).toEqual(['and-more/x.md']);
  });
});
