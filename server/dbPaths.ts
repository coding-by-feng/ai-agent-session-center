/** Side-effect-free resolution shared by startup and the explicit legacy history export. */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export function databaseDirectory(): string {
  // Keep the existing db.ts resolution: packaged APP_USER_DATA/data, otherwise repository data/.
  return process.env.APP_USER_DATA
    ? join(process.env.APP_USER_DATA, 'data')
    : join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
}
