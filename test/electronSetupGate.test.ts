import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// electron/ can't be imported without booting Electron, so these pin the source text.
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

describe('setup gate once the preload loads', () => {
  const main = read('electron/main.ts');

  it('marks an already-used install as set up before the first window reads the flag', () => {
    const ready = main.indexOf('app.whenReady().then(');
    const adopt = main.indexOf('adoptExistingInstall()', ready);
    const create = main.indexOf('await createWindow()', ready);
    expect(ready).toBeGreaterThan(-1);
    expect(adopt).toBeGreaterThan(ready);
    expect(adopt).toBeLessThan(create);
  });

  it('recognises a used install by files the embedded server actually writes', () => {
    const db = read('server/db.ts');
    expect(db).toMatch(/join\(process\.env\.APP_USER_DATA, 'data'\)/);
    expect(db).toMatch(/join\(DB_DIR, 'sessions\.db'\)/);
    expect(read('server/serverConfig.ts')).toMatch(/join\(process\.env\.APP_USER_DATA, 'server-config\.json'\)/);
    expect(main).toMatch(/path\.join\(userData, 'data', 'sessions\.db'\)/);
    expect(main).toMatch(/path\.join\(userData, 'server-config\.json'\)/);
  });

  it('finishing the wizard reuses the running server instead of requiring an unpackaged one', () => {
    const handlers = read('electron/ipc/setupHandlers.ts');
    const start = handlers.indexOf("ipcMain.handle('setup:complete'");
    expect(start).toBeGreaterThan(-1);
    const body = handlers.slice(start);
    expect(body).not.toMatch(/startServer/);
    expect(body).not.toMatch(/'index\.js'/);
    expect(body).toMatch(/webContents\.reload\(\)/);
  });
});
