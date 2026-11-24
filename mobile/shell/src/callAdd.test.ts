import { describe, it, expect, vi } from 'vitest';
import {
  CALL_FILE_MAX_BYTES, addSkillToCall, commandChoices, decideMemory, parseMemory, parsePending, removeFromCall, requestCommands, requestMemory,
  uploadToCall,
} from './callAdd.js';
import type { HttpRequest, HttpRequester } from './http.js';

const line = { origin: 'http://100.64.0.2:3334', token: 'tok' };

function requester(status: number, data: unknown): HttpRequester & { last: () => HttpRequest } {
  const calls: HttpRequest[] = [];
  return {
    request: vi.fn(async (req: HttpRequest) => { calls.push(req); return { status, data }; }),
    last: () => calls[calls.length - 1],
  };
}

describe('uploadToCall', () => {
  it('sends the bytes raw with the name and type in headers, and answers the held item', async () => {
    const http = requester(201, { success: true, data: { item: { id: 'att1', kind: 'photo', name: '收据.jpg' } } });
    const out = await uploadToCall(http, line, 'call_1', { name: '收据.jpg', type: 'image/jpeg', base64: 'AAEC', size: 3 });
    expect(out).toEqual({ ok: true, item: { id: 'att1', kind: 'photo', name: '收据.jpg' } });
    const req = http.last();
    expect(req).toMatchObject({ method: 'POST', url: 'http://100.64.0.2:3334/api/voice/call/call_1/attach', bytes: 'AAEC' });
    expect(req.body).toBeUndefined();
    expect(req.headers).toMatchObject({
      Authorization: 'Bearer tok', 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('收据.jpg'), 'X-File-Type': 'image/jpeg',
    });
  });

  it('refuses a file over the Mac\'s cap without sending it', async () => {
    const http = requester(201, {});
    const out = await uploadToCall(http, line, 'c', { name: 'big.mov', type: 'video/quicktime', base64: '', size: CALL_FILE_MAX_BYTES + 1 });
    expect(out).toEqual({ ok: false, message: 'big.mov is over 100 MB.' });
    expect(http.request).not.toHaveBeenCalled();
  });

  it('says the Mac\'s reason, or that the Mac needs an update when it has no such route', async () => {
    expect(await uploadToCall(requester(409, { code: 'full', error: 'Your next question already carries 10 things' }), line, 'c', { name: 'a', type: '', base64: 'AA', size: 1 }))
      .toEqual({ ok: false, message: 'Your next question already carries 10 things' });
    expect(await uploadToCall(requester(404, { code: 'not_found', error: 'No such call' }), line, 'c', { name: 'a', type: '', base64: 'AA', size: 1 }))
      .toEqual({ ok: false, message: 'The call can no longer take it. Update AASC on the Mac if this keeps happening.' });
  });

  it('says the Mac could not be reached when the request fails', async () => {
    const http: HttpRequester = { request: vi.fn(async () => { throw new Error('timeout'); }) };
    expect(await uploadToCall(http, line, 'c', { name: 'a', type: '', base64: 'AA', size: 1 })).toEqual({ ok: false, message: 'Can’t reach the Mac right now.' });
  });
});

describe('addSkillToCall / removeFromCall', () => {
  it('posts the picked command as JSON', async () => {
    const http = requester(201, { success: true, data: { item: { id: 'att2', kind: 'skill', name: '/expense-log' } } });
    expect(await addSkillToCall(http, line, 'call_1', '/expense-log')).toEqual({ ok: true, item: { id: 'att2', kind: 'skill', name: '/expense-log' } });
    expect(http.last()).toMatchObject({ method: 'POST', url: 'http://100.64.0.2:3334/api/voice/call/call_1/skill', body: { name: '/expense-log' } });
  });

  it('deletes one by id', async () => {
    const http = requester(200, { success: true });
    expect(await removeFromCall(http, line, 'call_1', 'att1')).toBe(true);
    expect(http.last()).toMatchObject({ method: 'DELETE', url: 'http://100.64.0.2:3334/api/voice/call/call_1/attach/att1' });
    expect(await removeFromCall(requester(404, {}), line, 'call_1', 'att1')).toBe(false);
  });
});

describe('parsePending', () => {
  it('keeps well-formed items only', () => {
    expect(parsePending([{ id: 'a', kind: 'photo', name: 'x.jpg' }, { id: 'b', kind: 'virus', name: 'y' }, 'junk', { id: 3 }]))
      .toEqual([{ id: 'a', kind: 'photo', name: 'x.jpg' }]);
    expect(parsePending(undefined)).toEqual([]);
  });
});

describe('commands', () => {
  it('turns the index into tokens with each CLI\'s sigil, sorted by use then name', () => {
    const entries = [
      { name: 'review', description: 'Review code', cli: 'codex', kind: 'skill', source: 'user' },
      { name: 'plan', description: 'Plan it', cli: 'codex', kind: 'command', source: 'user' },
      { name: 'figma-use', description: 'Figma', cli: 'claude', kind: 'skill', source: 'plugin', pluginName: 'figma' },
      { bad: true },
    ];
    expect(commandChoices({ entries, usage: { '/plan': 4 } })).toEqual([
      { token: '/plan', description: 'Plan it' },
      { token: '/figma:figma-use', description: 'Figma' },
      { token: '$review', description: 'Review code' },
    ]);
  });

  it('asks the Mac for the Voice central\'s CLI', async () => {
    const http = requester(200, { entries: [], usage: {} });
    expect(await requestCommands(http, line, 'codex')).toEqual([]);
    expect(http.last()).toMatchObject({ method: 'GET', url: 'http://100.64.0.2:3334/api/commands?cli=codex' });
    expect(await requestCommands(requester(500, {}), line, 'claude')).toBeNull();
  });
});

describe('call memory', () => {
  it('keeps proposals and kept items, newest proposals first', () => {
    const items = [
      { id: 'm1', kind: 'preference', meant: 'Use Codex for reviews', heard: 'use codex', scope: 'global', status: 'kept', createdAt: 1 },
      { id: 'm2', kind: 'correction', meant: 'AASC', heard: 'ASC', scope: 'global', status: 'proposed', createdAt: 2 },
      { id: 'm3', kind: 'preference', meant: 'x', heard: 'x', scope: 'global', status: 'skipped', createdAt: 3 },
    ];
    expect(parseMemory({ items }).map((i) => i.id)).toEqual(['m2', 'm1']);
  });

  it('reads and decides through the Mac', async () => {
    const read = requester(200, { success: true, data: { items: [] } });
    expect(await requestMemory(read, line)).toEqual([]);
    expect(read.last()).toMatchObject({ method: 'GET', url: 'http://100.64.0.2:3334/api/voice/memory' });
    const decide = requester(200, { success: true });
    expect(await decideMemory(decide, line, 'm2', 'keep')).toBe(true);
    expect(decide.last()).toMatchObject({ method: 'POST', url: 'http://100.64.0.2:3334/api/voice/memory/m2', body: { action: 'keep' } });
  });
});
