// MachineAccountSettings.fixtures.ts — a fake of this computer's settings routes for the Account group's tests.
import { vi } from 'vitest';
import { screen } from '@testing-library/react';
import { useMachineAccountStore } from '@/stores/machineAccountStore';

export const SETTINGS_URL = '/api/resources/cloud/machines/settings';
export const SHOW = 'Show this computer to my account';
export const AUTO = 'Connect my account’s computers without asking';
export const PINNED = 'Set by this computer’s environment';

export type Publisher = { state: string; published: { lan: string | null; tailnet: string | null; public: string | null; port: number } | null };

export interface Settings {
  showOnAccount: boolean;
  addresses: { lan: boolean; tailnet: boolean; public: boolean };
  computerEnroll: 'ask' | 'auto';
  pinned: { showOnAccount: boolean; computerEnroll: boolean };
  publisher: Publisher;
}

export const PUBLISHED: Publisher = { state: 'published', published: { lan: '192.168.1.57', tailnet: '100.101.102.103', public: null, port: 3333 } };

export function settings(over: Partial<Settings> = {}): Settings {
  return {
    showOnAccount: true,
    addresses: { lan: true, tailnet: true, public: false },
    computerEnroll: 'ask',
    pinned: { showOnAccount: false, computerEnroll: false },
    publisher: PUBLISHED,
    ...over,
  };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const answer = (data: Settings) => json(200, { success: true, data });

export interface Call { method: string; body: unknown; contentType: string | null }

/** The fake server; a test replaces `onGet` / `onPut` to choose the next answers. */
export interface FakeServer {
  calls: Call[];
  onGet: () => Response | Promise<Response>;
  /** Given the PUT's body. */
  onPut: (body: Record<string, unknown>) => Response | Promise<Response>;
  puts: () => Call[];
}

/** Call in `beforeEach`: a fresh server behind `fetch`, and no saves left over from the test before. */
export function installServer(): FakeServer {
  // The saves belong to the page: each test starts with none, whatever the one before left going out.
  useMachineAccountStore.setState({ saved: null, waiting: [], saving: false, error: null });
  const server: FakeServer = {
    calls: [],
    onGet: () => answer(settings()),
    // The server answers the saved choice with what its publisher then found.
    onPut: (body) => answer(settings({ ...(body as Partial<Settings>) })),
    puts: () => server.calls.filter((c) => c.method === 'PUT'),
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== SETTINGS_URL) return json(404, { error: 'Not found' });
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    server.calls.push({ method, body, contentType: new Headers(init?.headers).get('content-type') });
    return method === 'PUT' ? server.onPut(body ?? {}) : server.onGet();
  }));
  return server;
}

export const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
