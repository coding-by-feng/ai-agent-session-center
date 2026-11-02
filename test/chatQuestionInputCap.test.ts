// test/chatQuestionInputCap.test.ts — a question's input reaches the phone chat whole (Nov 2 2026): Claude's
// AskUserQuestion and Codex's request_user_input(_async) get QUESTION_INPUT_CAP, not the 2 KB tool cap, so the
// chat's question card can draw every option and its description.
import { describe, expect, it } from 'vitest';
import { QUESTION_INPUT_CAP, TOOL_INPUT_CAP, toolInputCap, toolUseDraft } from '../server/chat/chatEntries.js';

const fourQuestions = {
  questions: Array.from({ length: 4 }, (_, q) => ({
    question: `Question ${q + 1}: which way should this part go?`,
    header: `Part ${q + 1}`,
    multiSelect: false,
    options: Array.from({ length: 4 }, (_, o) => ({ label: `Option ${o + 1}`, description: 'x'.repeat(120) })),
  })),
};

describe('question input cap', () => {
  it('gives question tools their own cap', () => {
    expect(toolInputCap('AskUserQuestion')).toBe(QUESTION_INPUT_CAP);
    expect(toolInputCap('request_user_input')).toBe(QUESTION_INPUT_CAP);
    expect(toolInputCap('request_user_input_async')).toBe(QUESTION_INPUT_CAP);
    expect(toolInputCap('Bash')).toBe(TOOL_INPUT_CAP);
  });

  it('keeps a four-question AskUserQuestion whole, where the tool cap would cut it', () => {
    expect(JSON.stringify(fourQuestions).length).toBeGreaterThan(TOOL_INPUT_CAP);
    const draft = toolUseDraft('toolu_1', 'AskUserQuestion', fourQuestions);
    expect(draft).toMatchObject({ kind: 'tool_use', input: fourQuestions });
    expect(draft).not.toHaveProperty('inputTruncated');
    expect(toolUseDraft('toolu_2', 'Bash', fourQuestions)).toMatchObject({ inputTruncated: true });
  });
});
