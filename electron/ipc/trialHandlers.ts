import { app, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import type { TrialClient } from '../../bin/trial/client.cjs';
import { createSecureTrialStore } from '../trial/store.js';
import { invokeTrialAction, type TrialAction } from '../trial/actions.js';

// The renderer receives five fixed operations, never a cookie, provider key or arbitrary URL.
export function registerTrialHandlers(): void {
  let client: TrialClient | null = null;
  const getClient = (): TrialClient => {
    if (client) return client;
    const core = require(
      path.join(app.getAppPath(), 'bin', 'trial', 'client.cjs'),
    ) as typeof import('../../bin/trial/client.cjs');
    const store = createSecureTrialStore({
      file: path.join(app.getPath('userData'), 'trial', 'session.enc.json'),
      crypto: {
        isAvailable: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== 'linux' ||
            safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (value) => safeStorage.decryptString(value),
      },
    });
    // Test-only endpoint override is validated as loopback by the shared core.
    const origin = !app.isPackaged ? process.env.AASC_TRIAL_TEST_ORIGIN : undefined;
    client = core.createTrialClient({ store, ...(origin ? { origin } : {}) });
    return client;
  };
  for (const action of ['refresh', 'activate', 'ask', 'retry', 'logout'] as TrialAction[]) {
    ipcMain.handle(`trial:${action}`, async (event, input?: unknown) => {
      const origin = `http://localhost:${process.env.SERVER_PORT ?? '3332'}`;
      const sender = {
        url: event.senderFrame?.url ?? '',
        mainFrame: event.senderFrame === event.sender.mainFrame,
      };
      try {
        if (!sender.mainFrame || new URL(sender.url).origin !== origin)
          return { ok: false, error: 'untrusted_window' };
      } catch {
        return { ok: false, error: 'untrusted_window' };
      }
      try {
        return await invokeTrialAction(getClient(), origin, sender, action, input);
      } catch {
        return { ok: false, error: 'credential_store_unavailable' };
      }
    });
  }
}
