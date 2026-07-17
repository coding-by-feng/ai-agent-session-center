import { describe, it, expect } from 'vitest';
import { formatPopupResponse } from './popupResponse';

describe('formatPopupResponse', () => {
  it('returns empty string for empty input', () => {
    expect(formatPopupResponse('')).toBe('');
  });

  it('leaves a clean markdown answer untouched', () => {
    const answer = [
      '# pullback',
      '',
      '**词性 (Part of Speech):** 名词 (noun)',
      '',
      '**释义 (Definition):**',
      '1. （金融/交易）价格的短暂回调。',
      '2. （一般用法）撤回、后撤。',
    ].join('\n');
    expect(formatPopupResponse(answer)).toBe(answer);
  });

  it('drops the leading heredoc continuation-prompt echo block', () => {
    const raw = [
      'quote>  =Include: part of speech;',
      'quote>  =Surrounding line: "pullback"',
      'The answer.',
    ].join('\n');
    expect(formatPopupResponse(raw)).toBe('The answer.');
  });

  it('drops the leading spawn command echo line', () => {
    const raw = [
      "cclaude --resume '624924b6' --fork-session 'Act as a dictionary...'",
      'Real answer line.',
    ].join('\n');
    expect(formatPopupResponse(raw)).toBe('Real answer line.');
  });

  it('drops a leading bare shell prompt line', () => {
    const raw = [
      '~/Documents/kason-tools/btc-5min-trade (main x) %',
      'Answer.',
    ].join('\n');
    expect(formatPopupResponse(raw)).toBe('Answer.');
  });

  it('drops the leading ClaudeCode / Welcome back banner chrome', () => {
    const raw = ['7 8ClaudeCode', '', 'Welcome back Kason!', 'Answer.'].join('\n');
    expect(formatPopupResponse(raw)).toBe('Answer.');
  });

  it('reduces a chrome-only capture to empty', () => {
    // The pathological screenshot case: the snapshot caught the CLI mid-startup,
    // so it contains only command-echo + heredoc + banner, no answer.
    const raw = [
      "% ~/Documents/kason-tools/btc-5min-trade (main x) cclaude --resume '624924b6' --fork-session 'A cct as a bilingual dictionary. >",
      'quote>  =IInclude: part of speech; >',
      'quote>  =SSurrounding line: "pullback" >',
      'quote>  =WWord or phrase: >',
      'quote>  ="""" >',
      'quote>  =ppullback >',
      ' 7 8ClaudeCode',
      '',
      'WelcomebackKason!',
    ].join('\n');
    expect(formatPopupResponse(raw)).toBe('');
  });

  it('extracts the answer from a capture with a full junk header', () => {
    const raw = [
      "~/proj (main) % claude --fork-session 'prompt'",
      'quote>  =prompt body',
      'Welcome back!',
      '',
      '# Result',
      '',
      'Body text.',
    ].join('\n');
    expect(formatPopupResponse(raw)).toBe('# Result\n\nBody text.');
  });

  it('trims a trailing returned shell prompt', () => {
    const raw = ['Answer text.', '~/proj (main) % '].join('\n');
    expect(formatPopupResponse(raw)).toBe('Answer text.');
  });

  it('collapses runs of blank lines and trims trailing whitespace', () => {
    const raw = 'Line one.   \n\n\n\nLine two.';
    expect(formatPopupResponse(raw)).toBe('Line one.\n\nLine two.');
  });

  // --- Regression: never delete interior answer content (over-strip guards) ---

  it('preserves interior answer lines that discuss --resume / --fork-session', () => {
    // fork-explain routinely explains selected terminal text containing these
    // flags; those explanatory lines must survive the formatted view.
    const raw = [
      '# Flags',
      '',
      'The `--resume` flag reattaches to the prior session.',
      'Use `--fork-session` to branch the conversation.',
    ].join('\n');
    expect(formatPopupResponse(raw)).toBe(raw);
  });

  it('preserves an answer line that begins with "Welcome back"', () => {
    // A fork-translate of marketing copy — not the CLI greeting.
    const raw = [
      '# Translation',
      '',
      'Welcome back, valued customer! 欢迎回来，尊贵的顾客！',
    ].join('\n');
    expect(formatPopupResponse(raw)).toBe(raw);
  });

  it('preserves an answer line that illustrates a shell prompt', () => {
    const raw = [
      '# Prompts',
      '',
      'Your prompt reads `~/project (main) $ ` before each command.',
    ].join('\n');
    expect(formatPopupResponse(raw)).toBe(raw);
  });

  it('preserves interior zsh-continuation example lines inside a code block', () => {
    const raw = ['# Loops', '', 'Example:', 'for> echo $i', 'for> done'].join('\n');
    expect(formatPopupResponse(raw)).toBe(raw);
  });

  it('preserves prose that merely mentions "welcome back" mid-line', () => {
    const raw = 'You are always welcome back to the codebase.';
    expect(formatPopupResponse(raw)).toBe(raw);
  });

  it('preserves a leading "Welcome back" greeting that is real answer content', () => {
    // Not the CLI banner — no strong chrome precedes it, so it must survive.
    const raw = ['Welcome back, everyone!', '', 'This release adds three features.'].join('\n');
    expect(formatPopupResponse(raw)).toBe(raw);
  });

  it('preserves an answer that is only continuation-prompt-looking example lines', () => {
    const raw = ['for> echo $i', 'for> done'].join('\n');
    expect(formatPopupResponse(raw)).toBe(raw);
  });

  it('preserves a leading answer line that quotes the full spawn command in prose', () => {
    const raw = [
      'This command runs `claude --resume abc --fork-session xyz` to branch.',
      '',
      'It keeps the prior history.',
    ].join('\n');
    expect(formatPopupResponse(raw)).toBe(raw);
  });

  it('preserves a leading markdown heading that names the spawn command', () => {
    // "#" is the heading marker, not a shell-prompt sigil — must not be chrome.
    const raw = [
      '# Using claude --resume and --fork-session',
      '',
      'These two flags differ.',
    ].join('\n');
    expect(formatPopupResponse(raw)).toBe(raw);
  });

  it('preserves prose beginning with a $-sigil word that mentions the command', () => {
    const raw = [
      'Set $CLAUDE_HOME then run claude --resume abc --fork-session to branch.',
      '',
      'Details follow.',
    ].join('\n');
    expect(formatPopupResponse(raw)).toBe(raw);
  });

  it('does not let a heading naming the command strip a following real greeting', () => {
    // Regression: a false-strong leading match used to unlock weak-greeting
    // stripping and delete the next real line too.
    const raw = ['# claude --resume notes', 'Welcome back, friend!', '', 'Body.'].join('\n');
    expect(formatPopupResponse(raw)).toBe(raw);
  });
});
