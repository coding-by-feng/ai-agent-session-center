// pushSetup.ts — push on the phone, wired to the shell (AASC-19).
//
// At every start: the Android channels (pushChannels.ts) are created — that needs no
// Firebase — and then, only if the app was built with its Firebase config, the registrar
// (pushRegistration.ts) re-sends the token ('launch', never a prompt) and a notification tap
// goes through openFromTap (notificationTap.ts). Without the config everything stops after
// the channels: no permission prompt, no register() (it would throw), no listener.
// To turn it on: mobile/README.md "Turning push on".
import type { SessionResult } from './pairingClient.js';
import { openSession } from './pairingClient.js';
import { ANDROID_CHANNELS } from './pushChannels.js';
import { parsePush } from './pushPayload.js';
import { createPushRegistrar, type BackendCredential, type PushRegistrar } from './pushRegistration.js';
import { openFromTap, type TapOutcome } from './notificationTap.js';
import type { ShellDeps } from './native.js';
import { LAST_MAC_KEY, readBackendCredential, readMacCredentials, type SavedMac } from './savedMacs.js';
import { listSessions } from './sessions.js';
import { probeWith, SESSION_COOKIE_MAX_AGE } from './shellFlows.js';

export type PushStart =
  | { on: false; reason: 'no-push' | 'not-configured' }
  | { on: true; registrar: PushRegistrar };

export interface PushWiring {
  start(): Promise<PushStart>;
  /** A Mac just allowed this phone: ask for permission once (pushRegistration 'paired'). */
  paired(): Promise<void>;
  dispose(): void;
}

/** What a tap may need from the app: the Macs now, and what to do with the outcome. */
export interface PushAppHooks {
  macs(): readonly SavedMac[];
  onTapOutcome(outcome: TapOutcome): void;
  /** Biometric lock bookkeeping: a tap under way must not be cut by the prompt's own resume. */
  tapStarted?(): void;
  tapFinished?(): void;
}

async function backendCredentials(deps: ShellDeps, macs: readonly SavedMac[]): Promise<BackendCredential[]> {
  const found = await Promise.all(macs.map((m) => readBackendCredential(deps.vault, m.id).catch(() => null)));
  return found.filter((c): c is BackendCredential => c !== null);
}

/**
 * openFromTap's dependencies on the shell: sign in sets the WebView cookie (the token stays
 * in this closure for the one listing that follows, never in an outcome or storage).
 */
export function tapDeps(deps: ShellDeps, macs: readonly SavedMac[], lastServerId: string | null) {
  const tokens = new Map<string, string>();
  return {
    servers: macs,
    hints: { lastServerId, sessionOwners: [] as const },
    probe: probeWith(deps),
    async signIn(server: SavedMac, origin: string): Promise<SessionResult> {
      const creds = await readMacCredentials(deps.vault, server.id).catch(() => null);
      if (!creds) return { status: 'revoked' };
      const result = await openSession(deps.http, origin, creds);
      if (result.status === 'ok') {
        await deps.cookies.set(origin, result.token, SESSION_COOKIE_MAX_AGE);
        tokens.set(origin, result.token);
      }
      return result;
    },
    async listSessions(_server: SavedMac, origin: string) {
      const token = tokens.get(origin);
      return token ? listSessions(deps.requester, origin, token) : ({ status: 'signed-out' } as const);
    },
  };
}

export function createPushWiring(deps: ShellDeps, app: PushAppHooks): PushWiring {
  let registrar: PushRegistrar | null = null;
  let credentials: BackendCredential[] = [];
  let offTap: (() => void) | null = null;

  async function handleTap(raw: unknown): Promise<void> {
    const arrival = parsePush(raw as Parameters<typeof parsePush>[0]);
    if (!arrival) return; // malformed: opens nothing
    app.tapStarted?.();
    try {
      const lastServerId = await deps.store.get(LAST_MAC_KEY);
      app.onTapOutcome(await openFromTap(arrival, tapDeps(deps, app.macs(), lastServerId)));
    } finally {
      app.tapFinished?.();
    }
  }

  return {
    async start() {
      const host = deps.push;
      if (!host) return { on: false, reason: 'no-push' };
      if (deps.os === 'android') await host.createChannels(ANDROID_CHANNELS).catch(() => undefined);
      if (!(await host.configured().catch(() => false))) return { on: false, reason: 'not-configured' };
      credentials = await backendCredentials(deps, app.macs());
      registrar = createPushRegistrar({
        platform: host.platform,
        store: deps.store,
        http: deps.requester,
        pairing: () => ({ paired: app.macs().length > 0, backend: credentials }),
        onRevoked: (deviceId) => {
          credentials = credentials.filter((c) => c.deviceId !== deviceId);
        },
      });
      offTap = host.onTap((n) => void handleTap(n).catch(() => undefined));
      await registrar.start('launch');
      return { on: true, registrar };
    },
    async paired() {
      if (!registrar) return;
      credentials = await backendCredentials(deps, app.macs());
      await registrar.start('paired');
    },
    dispose() {
      offTap?.();
      registrar?.dispose();
    },
  };
}
