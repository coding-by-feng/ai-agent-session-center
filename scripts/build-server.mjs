/**
 * Compiles server/index.ts to a CJS bundle for use in packaged Electron.
 * Uses --packages=external so node_modules are left as require() calls.
 * Injects an import.meta.url polyfill so server modules that use it still work.
 */
import { build } from 'esbuild';

await build({
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
});

console.log('✓ dist/server-bundle.cjs built');
