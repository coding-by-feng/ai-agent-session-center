// widgetModel.test.ts — AASC-21 M6: "N sessions need you" for the home-screen widget.
import { describe, it, expect } from 'vitest';
import {
  buildWidgetModel, applyPushToWidget, serializeWidgetModel, parseWidgetModel, widgetHeadline,
  WIDGET_MAX_BYTES, WIDGET_STORAGE_KEY, WIDGET_IOS_APP_GROUP, type WidgetModel,
} from './widgetModel';
import { parsePush } from './pushPayload';
import type { SessionLite } from './sessions';

const NOW = 1_760_000_000_000;
const TITLES = { showTitles: true };

function session(sessionId: string, status: SessionLite['status'], lastActivityAt: number, extra: Partial<SessionLite> = {}): SessionLite {
  return { sessionId, status, title: `Title ${sessionId}`, lastActivityAt, startedAt: 0, muted: false, hasInterruption: false, ...extra };
}

function push(kind: string, sessionRef: string, title = 'Pushed title') {
  return parsePush({ title, body: 'x', data: { v: '1', kind, sessionRef } })!;
}

describe('widgetHeadline', () => {
  it('says it plainly, with the right plural', () => {
    expect([0, 1, 2, 7].map(widgetHeadline)).toEqual(['Nothing needs you', '1 session needs you', '2 sessions need you', '7 sessions need you']);
  });
});

describe('buildWidgetModel', () => {
  it('counts approval and input, ignores muted and busy sessions, and picks the most urgent', () => {
    const model = buildWidgetModel([
      session('in-old', 'input', 100),
      session('ap-new', 'approval', 300),
      session('ap-old', 'approval', 200),
      session('busy', 'working', 50),
      session('quiet', 'approval', 10, { muted: true }),
    ], NOW, TITLES);
    expect(model).toMatchObject({
      v: 1, needYou: 3, approval: 2, input: 1, headline: '3 sessions need you',
      top: { ref: 'ap-old', title: 'Title ap-old', label: 'Needs approval' },
      updatedAt: NOW, source: 'sessions',
    });
    expect(model.entries.map((e) => e.ref)).toEqual(['ap-old', 'ap-new', 'in-old']);
  });

  it('treats an unknown time as now, so it never jumps the queue', () => {
    const model = buildWidgetModel([session('unknown', 'approval', 0), session('known', 'approval', 500)], NOW, TITLES);
    expect(model.entries.map((e) => [e.ref, e.since])).toEqual([['known', 500], ['unknown', NOW]]);
  });

  it('shows nothing urgent when nothing needs you', () => {
    expect(buildWidgetModel([session('a', 'working', 1)], NOW, TITLES)).toMatchObject({ needYou: 0, top: null, headline: 'Nothing needs you' });
  });

  it('keeps titles off the home screen in generic mode, and caps them otherwise', () => {
    const generic = buildWidgetModel([session('a', 'input', 1)], NOW, { showTitles: false });
    expect(generic.top).toEqual({ ref: 'a', title: 'A session', label: 'Waiting for input' });
    expect(generic.entries[0].title).toBeNull();
    const long = buildWidgetModel([session('a', 'input', 1, { title: 'x'.repeat(80) })], NOW, TITLES);
    expect([...long.top!.title].length).toBe(32);
  });
});

describe('applyPushToWidget', () => {
  it('adds a session that needs you and removes it when it finishes', () => {
    let model = applyPushToWidget(null, push('approval', 's1'), NOW, TITLES);
    expect(model).toMatchObject({ needYou: 1, approval: 1, source: 'push', top: { ref: 's1', title: 'Pushed title' } });
    model = applyPushToWidget(model, push('input', 's2'), NOW + 1, TITLES);
    expect(model).toMatchObject({ needYou: 2, approval: 1, input: 1 });
    model = applyPushToWidget(model, push('input', 's1'), NOW + 2, TITLES); // approval → input: one entry, not two
    expect(model).toMatchObject({ needYou: 2, approval: 0, input: 2 });
    model = applyPushToWidget(model, push('finished', 's1'), NOW + 3, TITLES);
    model = applyPushToWidget(model, push('interrupted', 's2'), NOW + 4, TITLES);
    expect(model).toMatchObject({ needYou: 0, headline: 'Nothing needs you', updatedAt: NOW + 4 });
  });

  it('keeps generic pushes generic and ignores test notifications', () => {
    const generic = applyPushToWidget(null, push('approval', 's1', 'A session needs you'), NOW, TITLES);
    expect(generic.top?.title).toBe('A session');
    expect(applyPushToWidget(generic, push('test', 's9'), NOW + 5, TITLES)).toBe(generic);
  });
});

describe('storage', () => {
  it('round-trips through the JSON the widget reads', () => {
    const model = buildWidgetModel([session('a', 'approval', 5), session('b', 'input', 6)], NOW, TITLES);
    expect(parseWidgetModel(serializeWidgetModel(model))).toEqual(model);
    expect(WIDGET_STORAGE_KEY).toBe('aasc.widget.v1');
    expect(WIDGET_IOS_APP_GROUP).toBe('group.work.aasc.mobile');
  });

  it('recomputes what is shown, so a damaged value cannot show stale text', () => {
    const stored = JSON.stringify({
      v: 1, needYou: 99, headline: 'Hacked', updatedAt: NOW, source: 'push',
      entries: [{ ref: 'a', status: 'approval', title: 'ok', since: 1 }, { ref: '../x', status: 'approval', since: 1 }, { ref: 'b', status: 'nope', since: 1 }, { ref: 'a', status: 'input', title: 'dup', since: 2 }],
    });
    expect(parseWidgetModel(stored)).toMatchObject({ needYou: 1, headline: '1 session needs you', source: 'push' });
    expect(parseWidgetModel('not json')).toBeNull();
    expect(parseWidgetModel(JSON.stringify({ v: 2, entries: [], updatedAt: 1 }))).toBeNull();
    expect(parseWidgetModel(null)).toBeNull();
  });

  it('stays within the size budget even with huge titles', () => {
    const fat = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'.repeat(40);
    const sessions = Array.from({ length: 50 }, (_, i) => session(`s${i}`, 'approval', i + 1, { title: fat }));
    const model: WidgetModel = buildWidgetModel(sessions, NOW, TITLES);
    const json = serializeWidgetModel(model);
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(WIDGET_MAX_BYTES);
    const back = parseWidgetModel(json)!;
    expect(back.top?.ref).toBe('s0');
    expect(back.top?.title).toBe(model.top?.title);
  });
});
