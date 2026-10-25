// tools/queueWriteSteps.ts — the queue toolset's P2 writes on a prompt's chain: the steps that run before it and after it
// (add, edit, remove, move). A chain is how one queued prompt becomes a sequence (`/compact`, then the task, then
// "commit it"): the window's scheduler sends the steps one at a time, each when the turn before has finished.
//
// A step is added, taken out or moved only while its prompt is idle: the scheduler keeps a cursor into the chain, and
// changing the list under a running chain would make it skip a step or send one twice (BUSY). A step's text can be
// changed at any time. Like the prompts, a step is text typed into a session later, so it is cleaned and a shell
// line is refused (queueOps.ts). The chain of a prompt that is on is what AASC sends by itself, so none of it is
// changed until P4 (Ruling 43, `lockIfOn`); a prompt that is off waits for a person to turn it on.

import type { ToolDef } from '../registry.js';
import { addStep, editStep, moveStep, removeStep } from '../queueOps.js';
import { defineTool, SESSION_REF } from './define.js';
import {
  CHAIN,
  ITEM_ID,
  itemAnswer,
  lockIfOn,
  nameOf,
  ON_LOCK,
  PLACE,
  PROMPT_TEXT,
  RAILS,
  steerTarget,
  steerTargetForText,
  STEP_ID,
  type QueueWriteDeps,
  writeOp,
} from './queueWriteKit.js';

const addStepTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_add_step',
    toolset: 'queue',
    title: 'Add a step to a queued prompt',
    description:
      'Adds a step to a queued prompt’s `before` chain (typed ahead of the prompt) or `after` chain (typed behind ' +
      'it), last or at `position` (0 is first). The scheduler sends the steps in order, each when the turn before ' +
      'has finished. Refused while that prompt is partway through its chain, and past 20 steps in its two chains. The ' +
      `step text is plain text. ${ON_LOCK} ${RAILS}`,
    risk: 'steers',
    phase: 2,
    input: {
      id: SESSION_REF,
      itemId: ITEM_ID,
      chain: CHAIN,
      text: PROMPT_TEXT,
      position: PLACE.optional().describe('Where in the chain it goes: 0 is first. Leave out to add it last.'),
    },
    async run(args, ctx) {
      const s = await steerTargetForText(ctx, args.id, args.text);
      const change = await writeOp(deps, ctx, s, (state) => {
        lockIfOn(deps, ctx, s, state.items, args.itemId);
        return addStep(state, { itemId: args.itemId, chain: args.chain, text: args.text, position: args.position }, ctx.now());
      });
      const { stepId } = change.result;
      return itemAnswer({
        ctx,
        session: s,
        change,
        itemId: args.itemId,
        said: `Added a ${args.chain} step to a queued prompt of session ${nameOf(ctx, s)}.`,
        note: { summary: `Added a ${args.chain} step to a queued prompt`, targetSessionId: s.sessionId, detail: { itemId: args.itemId, chain: args.chain, stepId } },
        extra: { chain: args.chain, stepId },
      });
    },
  });

const editStepTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_edit_step',
    toolset: 'queue',
    title: 'Change a step of a queued prompt',
    description:
      'Replaces the text of one chain step (its id is in queue_get, under the prompt’s before or after steps). It can ' +
      `be done while the chain runs: a step that has already been sent is not sent again. ${ON_LOCK} ${RAILS}`,
    risk: 'steers',
    phase: 2,
    idempotent: true,
    input: { id: SESSION_REF, itemId: ITEM_ID, chain: CHAIN, stepId: STEP_ID, text: PROMPT_TEXT },
    async run(args, ctx) {
      const s = await steerTargetForText(ctx, args.id, args.text);
      const change = await writeOp(deps, ctx, s, (state) => {
        lockIfOn(deps, ctx, s, state.items, args.itemId);
        return editStep(state, { itemId: args.itemId, chain: args.chain, stepId: args.stepId, text: args.text });
      });
      return itemAnswer({
        ctx,
        session: s,
        change,
        itemId: args.itemId,
        said: `Changed the text of a ${args.chain} step of a queued prompt of session ${nameOf(ctx, s)}.`,
        note: { summary: `Edited a ${args.chain} step of a queued prompt`, targetSessionId: s.sessionId, detail: { itemId: args.itemId, chain: args.chain, stepId: args.stepId } },
        extra: { chain: args.chain, stepId: args.stepId },
      });
    },
  });

const removeStepTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_remove_step',
    toolset: 'queue',
    title: 'Remove a step from a queued prompt',
    description:
      'Takes one step out of a queued prompt’s before or after chain. Refused while that prompt is partway through ' +
      `its chain. ${ON_LOCK} ${RAILS}`,
    risk: 'write',
    phase: 2,
    input: { id: SESSION_REF, itemId: ITEM_ID, chain: CHAIN, stepId: STEP_ID },
    async run(args, ctx) {
      const s = steerTarget(ctx, args.id);
      const change = await writeOp(deps, ctx, s, (state) => {
        lockIfOn(deps, ctx, s, state.items, args.itemId);
        return removeStep(state, { itemId: args.itemId, chain: args.chain, stepId: args.stepId });
      });
      return itemAnswer({
        ctx,
        session: s,
        change,
        itemId: args.itemId,
        said: `Removed a ${args.chain} step from a queued prompt of session ${nameOf(ctx, s)}.`,
        note: { summary: `Removed a ${args.chain} step from a queued prompt`, targetSessionId: s.sessionId, detail: { itemId: args.itemId, chain: args.chain, stepId: args.stepId } },
        extra: { chain: args.chain, stepId: args.stepId },
      });
    },
  });

const moveStepTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_move_step',
    toolset: 'queue',
    title: 'Move a step of a queued prompt',
    description:
      'Moves one step within its chain: 0 is first, a place past the end is last. Answers with where it was and ' +
      `where it went. Refused while that prompt is partway through its chain. ${ON_LOCK} ${RAILS}`,
    risk: 'write',
    phase: 2,
    idempotent: true,
    input: { id: SESSION_REF, itemId: ITEM_ID, chain: CHAIN, stepId: STEP_ID, position: PLACE.describe('The place to move it to: 0 is first.') },
    async run(args, ctx) {
      const s = steerTarget(ctx, args.id);
      const change = await writeOp(deps, ctx, s, (state) => {
        lockIfOn(deps, ctx, s, state.items, args.itemId);
        return moveStep(state, { itemId: args.itemId, chain: args.chain, stepId: args.stepId, position: args.position });
      });
      const { from, to } = change.result;
      return itemAnswer({
        ctx,
        session: s,
        change,
        itemId: args.itemId,
        said: `Moved a ${args.chain} step of a queued prompt of session ${nameOf(ctx, s)} from place ${from} to place ${to}.`,
        note: { summary: `Moved a ${args.chain} step of a queued prompt`, targetSessionId: s.sessionId, detail: { itemId: args.itemId, chain: args.chain, stepId: args.stepId, from, to } },
        extra: { chain: args.chain, stepId: args.stepId, moved: { from, to } },
      });
    },
  });

/** The four chain-step tools over `deps`. */
export const stepTools = (deps: QueueWriteDeps): ToolDef[] => [
  addStepTool(deps),
  editStepTool(deps),
  removeStepTool(deps),
  moveStepTool(deps),
];
