'use strict';

// The native trial is deliberately independent of AASC's server, terminal and owner auth.
const { randomUUID: makeUUID } = require('node:crypto');
const { stripVTControlCharacters } = require('node:util');
const DEFAULT_TRIAL_ORIGIN = 'https://xclaude.dev';
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const ERROR_CODES = new Set([
  'unauthorized',
  'origin_forbidden',
  'code_unavailable',
  'invalid_request',
  'invalid_prompt',
  'invalid_input',
  'invalid_request_key',
  'trial_scope_restricted',
  'runtime_unavailable',
  'trial_revoked',
  'idempotency_conflict',
  'trial_expired',
  'turn_pending',
  'quota_exhausted',
  'runtime_busy',
  'daily_budget_exhausted',
  'rate_limited',
  'internal_error',
]);
const FRESH_NOT_ADMITTED = new Set([
  'trial_scope_restricted',
  'invalid_request',
  'invalid_prompt',
  'invalid_input',
  'invalid_request_key',
]);

class TrialClientError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = 'TrialClientError';
    this.code = code;
    this.status = status;
  }
}
function fail(code, status) {
  throw new TrialClientError(code, status);
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function text(value, max, empty = false) {
  return typeof value === 'string' && value.length <= max && (empty || value.length > 0);
}
function clone(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}
function sanitizeTerminalText(value) {
  return stripVTControlCharacters(String(value)).replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    '',
  );
}
function safeOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('invalid_origin');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    fail('invalid_origin');
  const loopback =
    url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.origin !== DEFAULT_TRIAL_ORIGIN && !loopback) fail('invalid_origin');
  return url.origin;
}
function parseStatus(value) {
  if (
    !object(value) ||
    typeof value.available !== 'boolean' ||
    value.mode !== 'native_qa' ||
    value.policyVersion !== 'native-qa-v1' ||
    value.runtime !== 'claude-code' ||
    value.client !== 'aasc' ||
    value.turnLimit !== 3 ||
    value.concurrentTurns !== 1 ||
    !integer(value.inputLimit, 1, 600) ||
    !integer(value.contextTokenLimit, 1, 2500) ||
    !integer(value.outputTokenLimit, 1, 800) ||
    !integer(value.historyPairs, 0, 2) ||
    !integer(value.timeoutMs, 1, 45000)
  )
    fail('runtime_unavailable', 503);
  return Object.fromEntries(
    [
      'available',
      'mode',
      'policyVersion',
      'runtime',
      'client',
      'turnLimit',
      'inputLimit',
      'contextTokenLimit',
      'outputTokenLimit',
      'historyPairs',
      'timeoutMs',
      'concurrentTurns',
    ].map((key) => [key, value[key]]),
  );
}
function parseSession(value) {
  if (
    !object(value) ||
    !text(value.id, 160) ||
    !['active', 'expired', 'exhausted', 'revoked'].includes(value.state) ||
    !integer(value.remaining, 0, 3) ||
    !integer(value.completed, 0, 3) ||
    !integer(value.reserved, 0, 1) ||
    !integer(value.expiresAt, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(value.transcriptExpiresAt, 0, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(value.turns) ||
    value.turns.length > 500
  )
    fail('invalid_response');
  const turns = value.turns.map((turn) => {
    if (
      !object(turn) ||
      !text(turn.id, 160) ||
      !text(turn.requestKey, 160) ||
      !text(turn.prompt, 600) ||
      !(turn.answer === null || text(turn.answer, 32768, true)) ||
      !['pending', 'completed', 'failed', 'uncertain'].includes(turn.status) ||
      !integer(turn.createdAt, 0, Number.MAX_SAFE_INTEGER)
    )
      fail('invalid_response');
    const safe = {
      id: sanitizeTerminalText(turn.id),
      requestKey: turn.requestKey,
      prompt: sanitizeTerminalText(turn.prompt),
      answer: turn.answer === null ? null : sanitizeTerminalText(turn.answer),
      status: turn.status,
      createdAt: turn.createdAt,
    };
    // Reasons are identifiers, never upstream exception/provider text.
    if (turn.reason === null) safe.reason = null;
    else if (ERROR_CODES.has(turn.reason)) safe.reason = turn.reason;
    if (integer(turn.truncated, 0, 1)) safe.truncated = turn.truncated;
    return safe;
  });
  return {
    id: sanitizeTerminalText(value.id),
    state: value.state,
    remaining: value.remaining,
    completed: value.completed,
    reserved: value.reserved,
    expiresAt: value.expiresAt,
    transcriptExpiresAt: value.transcriptExpiresAt,
    turns,
  };
}
function validCookie(cookie, expectedName) {
  return (
    typeof cookie === 'string' &&
    cookie.length <= 4096 &&
    new RegExp(`^${expectedName}=[A-Za-z0-9._~-]+$`).test(cookie)
  );
}
function parseLocal(value, cookieName) {
  if (value === null) return { version: 1, cookie: null, pending: null };
  if (
    !object(value) ||
    value.version !== 1 ||
    !(value.cookie === null || validCookie(value.cookie, cookieName)) ||
    !(
      value.pending === null ||
      (object(value.pending) &&
        text(value.pending.requestKey, 160) &&
        /^[A-Za-z0-9_-]+$/.test(value.pending.requestKey) &&
        text(value.pending.prompt, 600) &&
        value.cookie)
    )
  )
    fail('storage_error');
  return {
    version: 1,
    cookie: value.cookie,
    pending: value.pending
      ? { requestKey: value.pending.requestKey, prompt: value.pending.prompt }
      : null,
  };
}

function createTrialClient(options) {
  if (
    !options ||
    !options.store ||
    typeof options.store.load !== 'function' ||
    typeof options.store.save !== 'function'
  )
    fail('storage_error');
  const origin = safeOrigin(options.origin || DEFAULT_TRIAL_ORIGIN);
  const cookieName = origin === DEFAULT_TRIAL_ORIGIN ? '__Host-aasc_trial' : 'aasc_trial';
  const fetchImpl = options.fetch || globalThis.fetch;
  const uuid = options.randomUUID || makeUUID;
  if (typeof fetchImpl !== 'function') fail('runtime_unavailable');
  let local;
  try {
    local = parseLocal(options.store.load(), cookieName);
  } catch {
    fail('storage_error');
  }
  let serviceStatus = null;
  let session = null;
  let busy = false;

  function persist(next) {
    try {
      options.store.save(clone(next));
    } catch {
      fail('storage_error');
    }
    local = next === null ? { version: 1, cookie: null, pending: null } : clone(next);
  }
  function getSnapshot() {
    return clone({
      status: serviceStatus,
      session,
      pending: local.pending
        ? {
            requestKey: local.pending.requestKey,
            prompt: sanitizeTerminalText(local.pending.prompt),
          }
        : null,
      busy,
    });
  }
  async function exclusive(operation) {
    if (busy) fail('client_busy');
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  }
  function receiveCookie(headers) {
    const values =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : [headers.get('set-cookie') || ''];
    const candidates = values.filter((value) => value.trimStart().startsWith(`${cookieName}=`));
    if (!candidates.length) return;
    if (candidates.length !== 1) fail('invalid_response');
    const parts = candidates[0].split(';').map((part) => part.trim());
    const pair = parts.shift();
    const attrs = parts.map((part) => part.toLowerCase());
    if (
      !validCookie(pair, cookieName) ||
      !attrs.includes('httponly') ||
      !attrs.includes('path=/') ||
      attrs.some((attr) => attr.startsWith('domain=')) ||
      (origin === DEFAULT_TRIAL_ORIGIN && !attrs.includes('secure'))
    )
      fail('invalid_response');
    if (local.pending && local.cookie && local.cookie !== pair) fail('credential_changed');
    if (pair !== local.cookie) persist({ ...local, cookie: pair });
  }
  async function request(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      let response;
      try {
        response = await fetchImpl(`${origin}/api/trial/${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Accept: 'application/json',
            Origin: origin,
            ...(local.cookie ? { Cookie: local.cookie } : {}),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
        });
      } catch {
        fail('network_error');
      }
      if (response.status === 204 && path === 'logout') return null;
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || ''))
        fail('invalid_response');
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        fail('invalid_response');
      }
      if (!response.body) fail('invalid_response');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            fail('invalid_response');
          }
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        if (error instanceof TrialClientError) throw error;
        fail('network_error');
      }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        fail('invalid_response');
      }
      if (!response.ok)
        fail(
          object(value) && ERROR_CODES.has(value.error) ? value.error : 'server_error',
          response.status,
        );
      // Cookies are consumed only after a successful bounded JSON response.
      receiveCookie(response.headers);
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
  async function readStatus() {
    serviceStatus = null;
    serviceStatus = parseStatus(await request('status'));
    return clone(serviceStatus);
  }
  function accept(value) {
    const next = parseSession(value);
    if (local.pending && next.turns.some((turn) => turn.requestKey === local.pending.requestKey))
      persist({ ...local, pending: null });
    session = next;
  }
  async function readState() {
    if (!local.cookie) {
      session = null;
      return;
    }
    try {
      accept(await request('session'));
    } catch (error) {
      if (error instanceof TrialClientError && error.status === 401) {
        session = null;
        return;
      }
      throw error;
    }
  }
  function available() {
    if (!serviceStatus?.available) fail('runtime_unavailable', 503);
  }
  function writable() {
    if (!session) fail('unauthorized', 401);
    if (session.state === 'revoked') fail('trial_revoked', 403);
    if (session.state === 'expired' || session.expiresAt <= Date.now()) fail('trial_expired', 403);
    if (
      session.reserved ||
      session.turns.some((turn) => ['pending', 'uncertain'].includes(turn.status))
    )
      fail('turn_pending', 409);
    if (session.state === 'exhausted' || session.remaining <= 0) fail('quota_exhausted', 403);
  }
  async function submit(pending, fresh) {
    try {
      accept(await request('turns', pending));
    } catch (error) {
      if (
        fresh &&
        error instanceof TrialClientError &&
        error.status >= 400 &&
        error.status < 500 &&
        FRESH_NOT_ADMITTED.has(error.code)
      )
        persist({ ...local, pending: null });
      throw error;
    }
  }
  return {
    getSnapshot,
    status: () => exclusive(readStatus),
    async state() {
      await exclusive(readState);
      return getSnapshot();
    },
    async activate(code) {
      await exclusive(async () => {
        if (local.pending) fail('turn_pending', 409);
        if (typeof code !== 'string' || !code.trim() || code.trim().length > 256)
          fail('invalid_request', 400);
        await readStatus();
        available();
        if (!local.cookie) fail('credential_missing');
        accept(await request('activate', { code: code.trim() }));
      });
      return getSnapshot();
    },
    async ask(prompt) {
      await exclusive(async () => {
        if (local.pending) fail('turn_pending', 409);
        await readStatus();
        available();
        if (
          typeof prompt !== 'string' ||
          !prompt.trim() ||
          prompt.trim().length > serviceStatus.inputLimit
        )
          fail('invalid_prompt', 400);
        await readState();
        writable();
        const requestKey = uuid();
        if (!text(requestKey, 160) || !/^[A-Za-z0-9_-]+$/.test(requestKey))
          fail('invalid_request_key', 400);
        const pending = { requestKey, prompt: prompt.trim() };
        persist({ ...local, pending });
        await submit(pending, true);
      });
      return getSnapshot();
    },
    async retry() {
      await exclusive(async () => {
        await readStatus();
        await readState();
        if (!local.pending) return;
        available();
        writable();
        // A retry never invents a key, changes the prompt or silently reposts in a loop.
        await submit(clone(local.pending), false);
      });
      return getSnapshot();
    },
    async logout() {
      await exclusive(async () => {
        if (local.cookie) {
          try {
            await request('logout', {});
          } catch (error) {
            // A lost successful response leaves a revoked cookie behind. A
            // confirmed unauthorized reply proves it is already signed out.
            if (
              !(error instanceof TrialClientError) ||
              error.status !== 401 ||
              error.code !== 'unauthorized'
            )
              throw error;
          }
        }
        persist(null);
        session = null;
      });
      return getSnapshot();
    },
  };
}
module.exports = {
  DEFAULT_TRIAL_ORIGIN,
  TrialClientError,
  createTrialClient,
  sanitizeTerminalText,
};
