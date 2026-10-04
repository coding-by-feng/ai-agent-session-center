import { describe, it, expect } from 'vitest';
import { sessionRobotPropsEqual, type RobotMemoProps } from './sessionRobotMemo';

const onSelect = () => undefined;
const workstations: unknown[] = [];
const wallRects: unknown[] = [];
const rooms: unknown[] = [];
const doors: unknown[] = [];

const base = (): RobotMemoProps => ({
  session: {
    sessionId: 's1',
    status: 'working',
    accentColor: '#00f0ff',
    colorIndex: 2,
    model: 'claude',
    currentPrompt: 'do the thing',
    pendingTool: null,
    characterModel: 'robot',
    title: 'Queue float',
    projectName: 'agent-manager',
    toolLog: [],
    events: [],
  },
  sceneBound: 20,
  onSelect,
  workstations,
  wallRects,
  rooms,
  doors,
  roomIndex: 1,
  globalCharacterModel: 'robot',
  fontSize: 13,
  isSelected: false,
  sceneStyle: 'diorama',
  clayTone: 'standard',
});

const withSession = (patch: Partial<RobotMemoProps['session']>): RobotMemoProps => ({
  ...base(),
  session: { ...base().session, ...patch },
});

describe('sessionRobotPropsEqual', () => {
  it('treats identical props as equal, so an unrelated update re-renders nothing', () => {
    expect(sessionRobotPropsEqual(base(), base())).toBe(true);
  });

  // Each field below changes what a robot draws or where it goes. Leave one out of the
  // comparator and the robot keeps drawing the old value until something else re-renders it.
  it.each<[string, RobotMemoProps]>([
    ['sessionId', withSession({ sessionId: 's2' })],
    ['status', withSession({ status: 'waiting' })],
    ['accentColor', withSession({ accentColor: '#ff00aa' })],
    ['colorIndex', withSession({ colorIndex: 3 })],
    ['model', withSession({ model: 'codex' })],
    ['currentPrompt', withSession({ currentPrompt: 'something else' })],
    ['pendingTool', withSession({ pendingTool: 'Bash' })],
    ['characterModel', withSession({ characterModel: 'mech' })],
    ['title', withSession({ title: 'Renamed' })],
    ['projectName', withSession({ projectName: 'other' })],
    ['toolLog length', withSession({ toolLog: [{}] as never })],
    ['events length', withSession({ events: [{}] as never })],
    ['sceneBound', { ...base(), sceneBound: 30 }],
    ['onSelect', { ...base(), onSelect: () => undefined }],
    ['workstations', { ...base(), workstations: [] }],
    ['wallRects', { ...base(), wallRects: [] }],
    ['rooms', { ...base(), rooms: [] }],
    ['doors', { ...base(), doors: [] }],
    ['roomIndex', { ...base(), roomIndex: 2 }],
    ['globalCharacterModel', { ...base(), globalCharacterModel: 'drone' }],
    ['fontSize', { ...base(), fontSize: 16 }],
    ['isSelected', { ...base(), isSelected: true }],
    ['sceneStyle', { ...base(), sceneStyle: 'cyberdrome' }],
    ['clayTone', { ...base(), clayTone: 'deep' }],
  ])('re-renders when %s changes', (_field, changed) => {
    expect(sessionRobotPropsEqual(base(), changed)).toBe(false);
  });

  it('is not disturbed by session fields a robot never reads', () => {
    const noisy = withSession({ ...({ lastActivityAt: 123, totalToolCalls: 99 } as object) });
    expect(sessionRobotPropsEqual(base(), noisy)).toBe(true);
  });

  it('compares the tool log and event list by length, not by content', () => {
    const a = withSession({ toolLog: [{ tool: 'Read' }] as never });
    const b = withSession({ toolLog: [{ tool: 'Edit' }] as never });
    expect(sessionRobotPropsEqual(a, b)).toBe(true);
  });

  it('reads a missing tool log like an empty one', () => {
    const missing = withSession({ toolLog: undefined as never });
    expect(sessionRobotPropsEqual(missing, base())).toBe(true);
  });
});
