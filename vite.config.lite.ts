import { mergeConfig } from 'vite';
import base from './vite.config';

/**
 * The Lite desktop build: the same code with `__AASC_EDITION__` set (src/lib/edition.ts).
 * Its own output folder, because dist/client is what `npm start` and the Full app serve;
 * electron-builder.lite.cjs ships this folder as dist/client, so the server needs no change.
 * `vite --config vite.config.lite.ts` runs the Lite UI in dev.
 */
export default mergeConfig(base, {
  define: { __AASC_EDITION__: JSON.stringify('lite') },
  build: { outDir: 'dist/client-lite' },
});
