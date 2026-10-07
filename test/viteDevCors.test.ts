// test/viteDevCors.test.ts — the dev server must not answer CORS preflights.
//
// Vite 7's default `server.cors` allows every localhost origin, on any port, and
// it answers the preflight BEFORE the /api proxy runs. While `npm run dev` or
// `electron:dev` is up, that let any page on any local port drive the API
// through port 3332: read /api/resources cross-origin, and reach the routes that
// write (uninstall, POST /api/terminals). The dashboard's own calls are
// same-origin, so it needs no CORS at all.
import { describe, it, expect } from 'vitest';
import config from '../vite.config';

describe('vite dev server', () => {
  it('turns CORS off', () => {
    expect((config as { server?: { cors?: unknown } }).server?.cors).toBe(false);
  });
});
