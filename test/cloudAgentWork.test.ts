// Code review, Oct 29 2026: Pull and Push wait for an agent working in the folder, and the Projects
// tab says one is; a session that finished its turn or sits idle is not working there.
import { expect, it } from 'vitest';
import { workingProjectPaths } from '../server/cloud/agentWork.js';

it('counts only sessions mid-turn, each with its folder', () => {
  expect(
    workingProjectPaths([
      { status: 'working', projectPath: '/h/a' },
      { status: 'prompting', projectPath: '/h/b' },
      { status: 'approval', projectPath: '/h/c' },
      { status: 'input', projectPath: '/h/d' },
      { status: 'waiting', projectPath: '/h/e' },
      { status: 'idle', projectPath: '/h/f' },
      { status: 'connecting', projectPath: '/h/g' },
      { status: 'ended', projectPath: '/h/h' },
      { status: 'working', projectPath: '' },
      { status: 'working' },
    ]),
  ).toEqual(['/h/a', '/h/b', '/h/c', '/h/d']);
});
