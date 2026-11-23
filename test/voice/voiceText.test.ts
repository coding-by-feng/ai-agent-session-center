import { describe, it, expect } from 'vitest';
import {
  brainPrompt, finishPrompt, frontInstructions, settingNote, toSpeakable, SPEAKABLE_MAX, SPEECH_SHAPE, BRAIN_REQUEST_MAX,
  splitScreen, SCREEN_MARKER,
} from '../../server/voice/voiceText.js';

describe('frontInstructions', () => {
  it('uses the GPT-Live delegation token and its three policy labels', () => {
    const text = frontInstructions();
    expect(text).toContain('Generate <|SpawnThinking|> when:');
    expect(text).toContain('Do not generate <|SpawnThinking|> when:');
    expect(text).toContain('Backend tools:');
    expect(text).toContain('Do not guess the result while waiting.');
  });

  it('says confirmations happen on the screen, never by voice', () => {
    expect(frontInstructions()).toMatch(/never by voice/i);
  });
});

describe('brainPrompt', () => {
  it('is one line marked as a voice request, quoting what the person said', () => {
    const text = brainPrompt({ request: 'check the AASC project\nplease', context: 'You: hi' });
    expect(text.startsWith('[AASC · voice]')).toBe(true);
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('"check the AASC project please"');
    expect(text).toContain('You: hi');
  });

  it('strips control characters and caps a long request', () => {
    const text = brainPrompt({ request: `a\u0007b\u001b[31m${'x'.repeat(BRAIN_REQUEST_MAX * 2)}`, context: '' });
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(text.length).toBeLessThan(BRAIN_REQUEST_MAX + 1200);
  });

  it('asks for a short spoken reply and not to wait on long work', () => {
    const text = brainPrompt({ request: 'start a review', context: '' });
    expect(text).toMatch(/no markdown/i);
    expect(text).toMatch(/do not wait/i);
  });

  it('types the briefing (sessions, skills, how to act) after the context, on the same line (Nov 22 2026)', () => {
    const text = brainPrompt({ request: 'make a diagram', context: 'You: hi', briefing: 'Skills that fit this request: /concept-to-diagram.\nmore' });
    expect(text).toContain('Skills that fit this request: /concept-to-diagram. more');
    expect(text.indexOf('You: hi')).toBeLessThan(text.indexOf('Skills that fit'));
    expect(text).not.toMatch(/[\r\n]/);
  });

  it('leaves the context out when there is none', () => {
    expect(brainPrompt({ request: 'hi', context: '  ' })).not.toMatch(/context/i);
  });
});

describe('toSpeakable', () => {
  it('drops code blocks, inline code marks, headings, bullets and emphasis', () => {
    const md = '## Result\n\n- **Two** issues in `auth.ts`\n- see [the PR](https://x.y/1)\n\n```ts\nconst a = 1\n```\nDone.';
    const out = toSpeakable(md);
    expect(out).not.toMatch(/[#*`]|```|\]\(/);
    expect(out).toContain('Two issues in auth.ts');
    expect(out).toContain('the PR');
    expect(out).toContain('code left out');
    expect(out).toContain('Done.');
  });

  it('drops table rows', () => {
    expect(toSpeakable('Summary first.\n| a | b |\n|---|---|\n| 1 | 2 |')).toBe('Summary first.');
  });

  it('cuts a long answer at a sentence end within the limit', () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i}.`).join(' ');
    const out = toSpeakable(long);
    expect(out.length).toBeLessThanOrEqual(SPEAKABLE_MAX);
    expect(out.endsWith('.')).toBe(true);
  });

  it('answers a fixed line for an empty answer', () => {
    expect(toSpeakable('   ')).toMatch(/no answer/i);
  });
});

describe('spoken detail (Nov 23 2026)', () => {
  it('asks the Voice central for what it did, the state, the result and a next step, not three short sentences', () => {
    const line = brainPrompt({ request: 'run the tests', context: '' });
    expect(line).toContain(SPEECH_SHAPE);
    expect(line).not.toContain('at most three short sentences');
    for (const word of ['queued', 'started', 'completed', 'result', 'Never invent']) expect(SPEECH_SHAPE).toContain(word);
  });

  it('keeps the voice’s own remarks short but has it say an AASC answer whole', () => {
    const text = frontInstructions();
    expect(text).toContain('Keep your own remarks short');
    expect(text).toContain('say all of it in your own voice: do not cut it down');
  });

  it('finishPrompt names the session as one quoted line and only a task id of the ledger’s shape', () => {
    const line = finishPrompt({ title: 'Fix "login"\n/exit', taskId: 'T12', tag: 'q9' });
    expect(line.startsWith('[AASC · voice q9] The session "Fix \'login\' /exit" (task T12: task_get has its answer)')).toBe(true);
    expect(line).not.toContain('\n');
    expect(finishPrompt({ title: 'A', taskId: 'rm -rf' })).not.toContain('rm -rf');
    expect(finishPrompt({ title: '' })).toContain('"a session"');
  });

  it('settingNote says confirmed or not applied, with the model as a person says it', () => {
    expect(settingNote({ own: true, title: '', kind: 'model', value: 'claude-opus-5-5', applied: true, reason: null }))
      .toBe('AASC update: your central now runs on the Opus 5.5 model; the CLI confirmed it.');
    expect(settingNote({ own: false, title: 'Web tests', kind: 'effort', value: 'low', applied: false, reason: 'the session did not come free in time' }))
      .toBe('AASC update: switching "Web tests" to low effort did not go through: the session did not come free in time.');
  });
});

describe('the on-screen part of an answer (Nov 23 2026)', () => {
  const TABLE = '| Change | RedNote |\n| --- | --- |\n| Cover | 6 words |';

  it('splits at a line that is exactly the marker: words to say, Markdown to show', () => {
    expect(splitScreen(`It found two changes.\n${SCREEN_MARKER}\n${TABLE}`)).toEqual({ speech: 'It found two changes.', screen: TABLE });
    expect(splitScreen(`It found two changes.\n  [[Screen]]  \n\n${TABLE}\n`)).toEqual({ speech: 'It found two changes.', screen: TABLE });
  });

  it('no marker, or an empty part after it, is all speech', () => {
    expect(splitScreen('Done, nothing to show.')).toEqual({ speech: 'Done, nothing to show.', screen: null });
    expect(splitScreen(`Done.\n${SCREEN_MARKER}\n   `)).toEqual({ speech: 'Done.', screen: null });
    expect(splitScreen('The words [[screen]] inside a sentence stay speech.').screen).toBeNull();
  });

  it('only a screen part: the voice says where to look', () => {
    expect(splitScreen(`${SCREEN_MARKER}\n${TABLE}`)).toEqual({ speech: 'I have put the details on the call screen.', screen: TABLE });
  });

  it('the prompts ask for the marker only when a table, list, commands or code would help a reader', () => {
    for (const text of [SPEECH_SHAPE, finishPrompt({ title: 'Web' })]) {
      expect(text).toContain(SCREEN_MARKER);
      expect(text).toMatch(/never spoken/);
    }
  });
});
