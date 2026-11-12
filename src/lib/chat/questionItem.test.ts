import { describe, expect, it } from 'vitest';
import { claudeAnswers, codexAnswers, codexReply, isCodexQuestionTool, isQuestionTool, parseQuestions } from './questionItem';

const claudeInput = {
  questions: [
    {
      question: 'Which layout should I build?',
      header: 'Layout',
      multiSelect: false,
      options: [
        { label: 'Cards (Recommended)', description: 'One per project' },
        { label: 'List', description: 'Denser' },
      ],
    },
  ],
};

describe('parseQuestions', () => {
  it('reads Claude AskUserQuestion input', () => {
    expect(parseQuestions(claudeInput)).toEqual([
      {
        question: 'Which layout should I build?',
        header: 'Layout',
        multiSelect: false,
        options: [
          { label: 'Cards (Recommended)', description: 'One per project' },
          { label: 'List', description: 'Denser' },
        ],
      },
    ]);
  });

  it('reads the older single-question form', () => {
    expect(parseQuestions({ question: 'Go on?', options: [{ label: 'Yes' }, { label: 'No' }] })).toEqual([
      { question: 'Go on?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
    ]);
  });

  it('reads Codex request_user_input: title + string options, or none', () => {
    expect(parseQuestions({ questions: [{ title: 'Deploy which?', options: ['Current (recommended)', 'Local'] }, { title: 'Anything else?', options: null }] })).toEqual([
      { question: 'Deploy which?', multiSelect: false, options: [{ label: 'Current (recommended)' }, { label: 'Local' }] },
      { question: 'Anything else?', multiSelect: false, options: [] },
    ]);
  });

  it('is null for input it cannot read', () => {
    expect(parseQuestions(null)).toBeNull();
    expect(parseQuestions({ redacted: true })).toBeNull();
    expect(parseQuestions({ questions: [{ options: ['A'] }] })).toBeNull();
  });
});

describe('question tools', () => {
  it('knows Claude and Codex question tools', () => {
    expect(isQuestionTool('AskUserQuestion')).toBe(true);
    expect(isQuestionTool('request_user_input_async')).toBe(true);
    expect(isQuestionTool('Bash')).toBe(false);
    expect(isCodexQuestionTool('request_user_input')).toBe(true);
    expect(isCodexQuestionTool('AskUserQuestion')).toBe(false);
  });
});

describe('claudeAnswers', () => {
  const questions = parseQuestions(claudeInput)!;

  it('reads the pick from the result', () => {
    const out = 'User has answered your questions: "Which layout should I build?"="Cards (Recommended)". You can now continue with the user\'s answers in mind.';
    expect(claudeAnswers(out, questions)).toEqual([['Cards (Recommended)']]);
  });

  it('reads several questions and splits a multi-select into options', () => {
    const qs = parseQuestions({
      questions: [
        { question: 'Which "mode"?', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Which parts?', multiSelect: true, options: [{ label: 'Docs' }, { label: 'Tests' }] },
      ],
    })!;
    const out = 'Your questions have been answered: "Which "mode"?"="B", "Which parts?"="Docs, Tests". You can now continue';
    expect(claudeAnswers(out, qs)).toEqual([['B'], ['Docs', 'Tests']]);
  });

  it('keeps a typed answer whole', () => {
    const out = 'User has answered your questions: "Which layout should I build?"="Something else, thanks".';
    expect(claudeAnswers(out, questions)).toEqual([['Something else, thanks']]);
  });

  it('is null when the result does not say (cut off, declined)', () => {
    expect(claudeAnswers('The user doesn\'t want to proceed with this tool use.', questions)).toEqual([null]);
    expect(claudeAnswers('User has answered your questions: "Which layout should I build?"="Car', questions)).toEqual([null]);
  });
});

describe('codexAnswers / codexReply', () => {
  const one = parseQuestions({ questions: [{ title: 'Deploy which?', options: ['Current', 'Local'] }] })!;
  const two = parseQuestions({ questions: [{ title: 'Owner?', options: ['Me', 'Team'] }, { title: 'Region?', options: ['NZ', 'AU'] }] })!;

  it('marks a reply that is exactly an option', () => {
    expect(codexAnswers('Local', one)).toEqual([['Local']]);
    expect(codexAnswers('  Local \n', one)).toEqual([['Local']]);
  });

  it('marks nothing for a reply in your own words', () => {
    expect(codexAnswers('proceed with local please', one)).toEqual([null]);
    expect(codexAnswers(null, one)).toEqual([null]);
  });

  it('sends the label for one question, one line each for several, and reads them back', () => {
    expect(codexReply(one, ['Current'])).toBe('Current');
    const reply = codexReply(two, ['Team', 'NZ']);
    expect(reply).toBe('Owner?: Team\nRegion?: NZ');
    expect(codexAnswers(reply, two)).toEqual([['Team'], ['NZ']]);
  });
});
