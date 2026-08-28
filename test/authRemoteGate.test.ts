// test/authRemoteGate.test.ts — a password is MANDATORY for non-loopback access.
//
// Before this gate, `authMiddleware` opened with `if (!isPasswordEnabled())
// next()`. With no `passwordHash` configured — the default, and the state of a
// fresh install — that served every `/api` route to anyone who could reach the
// port: full session content, PTY write, session kill. The server binds
// 0.0.0.0, logged a "DANGEROUS" warning, and then answered the request anyway.
//
// The gate is two-dimensional now. These tests pin BOTH axes, because getting
// either wrong is severe in opposite directions: too strict locks the user out
// of their own desktop app, too loose restores the hole.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const mockConfig: { passwordHash?: string } = {};
vi.mock('../server/serverConfig.js', () => ({ config: mockConfig }));
vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

let authMiddleware: typeof import('../server/authManager.js').authMiddleware;
let createToken: typeof import('../server/authManager.js').createToken;

beforeEach(async () => {
  vi.resetModules();
  delete mockConfig.passwordHash;
  ({ authMiddleware, createToken } = await import('../server/authManager.js'));
});

afterEach(() => { vi.clearAllMocks(); });

/** Minimal Express req/res doubles — only the fields the middleware reads. */
function mkReq(ip: string, headers: Record<string, string> = {}): Request {
  return {
    ip,
    socket: { remoteAddress: ip },
    headers,
    method: 'GET',
    originalUrl: '/api/sessions',
    cookies: undefined,
    query: {},
  } as unknown as Request;
}
function mkRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: { error?: string; code?: string } };
}

describe('no password configured', () => {
  it.each([
    ['127.0.0.1', 'IPv4 loopback'],
    ['::1', 'IPv6 loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped IPv6 loopback'],
  ])('ALLOWS %s (%s) — the desktop app must stay password-free', (ip) => {
    const next = vi.fn() as unknown as NextFunction;
    const res = mkRes();
    authMiddleware(mkReq(ip), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  it.each([
    ['192.168.7.231', 'LAN IPv4'],
    ['::ffff:192.168.7.231', 'IPv4-mapped LAN address'],
    ['10.0.0.5', 'private range'],
    ['203.0.113.9', 'public address'],
  ])('REJECTS %s (%s) with 403', (ip) => {
    const next = vi.fn() as unknown as NextFunction;
    const res = mkRes();
    authMiddleware(mkReq(ip), res, next);
    expect(next).not.toHaveBeenCalled();
    // 403, not 401: a 401 invites a login prompt and there is no credential
    // that would work, because none has been configured.
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('REMOTE_PASSWORD_REQUIRED');
  });

  it('REJECTS a request whose origin cannot be determined (fails closed)', () => {
    const next = vi.fn() as unknown as NextFunction;
    const res = mkRes();
    authMiddleware(mkReq(''), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe('password configured', () => {
  beforeEach(() => { mockConfig.passwordHash = 'salt:hash'; });

  it('ALLOWS a remote request carrying a valid token', () => {
    const token = createToken();
    const next = vi.fn() as unknown as NextFunction;
    const res = mkRes();
    authMiddleware(mkReq('192.168.7.231', { authorization: `Bearer ${token}` }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('REJECTS a remote request with a bad token as 401, not 403', () => {
    // 401 is correct HERE: a credential exists, this one is just wrong.
    const next = vi.fn() as unknown as NextFunction;
    const res = mkRes();
    authMiddleware(mkReq('192.168.7.231', { authorization: 'Bearer nope' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('REJECTS an unauthenticated LOOPBACK request too — a set password applies everywhere', () => {
    const next = vi.fn() as unknown as NextFunction;
    const res = mkRes();
    authMiddleware(mkReq('127.0.0.1'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
