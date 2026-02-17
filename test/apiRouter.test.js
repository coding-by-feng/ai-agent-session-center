// test/apiRouter.test.js — Integration tests for API endpoints
// Tests validation logic via actual HTTP requests to a test server
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { handleEvent, getAllSessions, setSessionTitle } from '../server/sessionStore.js';
import { EVENT_TYPES } from '../server/constants.js';

// We create a minimal test server with just the routes we need to test
let server;
let baseUrl;

async function startTestServer() {
  const app = express();
  app.use(express.json());

  // Import the actual apiRouter
  const { default: apiRouter, hookRateLimitMiddleware } = await import('../server/apiRouter.js');
  const hookRouter = (await import('../server/hookRouter.js')).default;

  app.use('/api', apiRouter);
  app.use('/api/hooks', hookRateLimitMiddleware, hookRouter);
  app.get('/api/sessions', (req, res) => {
    res.json(getAllSessions());
  });

  return new Promise((resolve) => {
    server = createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
}

function stopTestServer() {
  return new Promise((resolve) => {
    if (server) {
      server.close(resolve);
    } else {
      resolve();
    }
  });
}

describe('apiRouter - integration tests', () => {
  beforeAll(async () => {
    await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
  });

  describe('POST /api/hooks', () => {
    it('returns 200 for valid hook payload', async () => {
      const res = await fetch(`${baseUrl}/api/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'api-test-hook-1',
          hook_event_name: 'SessionStart',
          cwd: '/tmp/test',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('returns 400 for missing session_id', async () => {
      const res = await fetch(`${baseUrl}/api/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'SessionStart',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('session_id');
    });

    it('returns 400 for unknown event type', async () => {
      const res = await fetch(`${baseUrl}/api/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'api-test-hook-2',
          hook_event_name: 'InvalidEvent',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('unknown event type');
    });

    it('returns 400 for invalid claude_pid', async () => {
      const res = await fetch(`${baseUrl}/api/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'api-test-hook-3',
          hook_event_name: 'SessionStart',
          claude_pid: 'not-a-number',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('claude_pid');
    });
  });

  describe('GET /api/sessions', () => {
    it('returns an object with sessions', async () => {
      // Ensure at least one session exists
      handleEvent({
        session_id: 'api-test-sessions-1',
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: '/tmp/test',
      });
      const res = await fetch(`${baseUrl}/api/sessions`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body).toBe('object');
      expect(body['api-test-sessions-1']).toBeTruthy();
    });
  });

  describe('PUT /api/sessions/:id/title', () => {
    it('returns 200 for valid title', async () => {
      handleEvent({
        session_id: 'api-test-title-1',
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: '/tmp/test',
      });
      const res = await fetch(`${baseUrl}/api/sessions/api-test-title-1/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'My Session Title' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('returns 400 when title is missing', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/api-test-title-1/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('title');
    });

    it('returns 400 for too-long title', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/api-test-title-1/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x'.repeat(501) }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('500');
    });

    it('returns 400 for non-string title', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/api-test-title-1/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 12345 }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/sessions/:id/label', () => {
    it('returns 200 for valid label', async () => {
      handleEvent({
        session_id: 'api-test-label-1',
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: '/tmp/test',
      });
      const res = await fetch(`${baseUrl}/api/sessions/api-test-label-1/label`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'reviewer' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('returns 400 when label is missing', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/api-test-label-1/label`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/hook-stats', () => {
    it('returns hook stats', async () => {
      const res = await fetch(`${baseUrl}/api/hook-stats`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.totalHooks).toBe('number');
      expect(typeof body.hooksPerMin).toBe('number');
      expect(typeof body.events).toBe('object');
    });
  });

  describe('GET /api/mq-stats', () => {
    it('returns MQ reader stats', async () => {
      const res = await fetch(`${baseUrl}/api/mq-stats`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.linesProcessed).toBe('number');
      expect(typeof body.queueFile).toBe('string');
    });
  });

  describe('GET /api/sessions/:id/source', () => {
    it('returns session source', async () => {
      handleEvent({
        session_id: 'api-test-source-1',
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: '/tmp/test',
      });
      const res = await fetch(`${baseUrl}/api/sessions/api-test-source-1/source`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.source).toBe('string');
    });
  });

  describe('DELETE /api/sessions/:id', () => {
    it('deletes a session', async () => {
      handleEvent({
        session_id: 'api-test-delete-1',
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: '/tmp/test',
      });
      const res = await fetch(`${baseUrl}/api/sessions/api-test-delete-1`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.removed).toBe(true);
    });
  });
});
