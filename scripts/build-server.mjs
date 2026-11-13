/**
 * Compiles server/index.ts to a CJS bundle for use in packaged Electron and the headless server.
 * Uses --packages=external so node_modules are left as require() calls.
 * Injects an import.meta.url polyfill so server modules that use it still work.
 *
 * The options are exported so test/packServerManifest.test.ts builds the very same bundle.
 */
import { build } from 'esbuild';
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';

export const serverBuildOptions = {
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: 'dist/server-bundle.cjs',
  // CJS globals __filename / __dirname are available; polyfill import.meta.url
  banner: {
    js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    'import.meta.url': '__importMetaUrl',
  },
};

// Run as a script (npm run build:server), not when imported.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build(serverBuildOptions);
  console.log('✓ dist/server-bundle.cjs built');
}
