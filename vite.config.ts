import { defineConfig, createLogger } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import path from 'path';

// Local Kokoro TTS runs onnxruntime-web, whose ~21MB WASM binary transformers.js
// otherwise pulls from jsDelivr at runtime — which fails offline, behind a
// firewall, or wherever the CDN is blocked. Serve it from our own origin instead
// (see `src/lib/kokoroWorker.ts`). It can't be deep-imported by specifier because
// neither package's `exports` map exposes `./dist/*`, so resolve it on disk and
// alias it. Throwing here at config load is deliberate: a missing binary must
// break the build loudly rather than silently fall back to the CDN.
const nodeRequire = createRequire(path.join(__dirname, 'vite.config.ts'));
const ORT_WASM_FILE = path.join(
  path.dirname(nodeRequire.resolve('@huggingface/transformers')),
  'ort-wasm-simd-threaded.jsep.wasm',
);

// Suppress EPIPE/ECONNRESET noise from Vite's WS proxy.
// These happen every time the browser closes a WebSocket mid-proxy (page refresh,
// tab close, HMR reload). They are benign race conditions, not real errors.
const logger = createLogger();
const _origError = logger.error.bind(logger);
logger.error = (msg, opts) => {
  if (msg.includes('EPIPE') || msg.includes('ECONNRESET')) return;
  _origError(msg, opts);
};

export default defineConfig({
  customLogger: logger,
  plugins: [react()],
  publicDir: 'static',
  resolve: {
    // Array form so the ORT binary can be matched by regex — a string `find` is
    // compared against the bare specifier and would never match the `?url` query.
    alias: [
      { find: /^ort-wasm-binary\?url$/, replacement: `${ORT_WASM_FILE}?url` },
      { find: '@', replacement: path.resolve(__dirname, 'src') },
    ],
  },
  server: {
    port: 3332,
    proxy: {
      '/api': {
        target: 'http://localhost:3333',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3333',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    // NOTE: deliberately no `manualChunks`.
    //
    // Grouping vendors by name (`{ three: ['three', '@react-three/fiber'] }`)
    // looks like it splits the bundle, but it only renames bytes — and it
    // actively backfires. Rollup assigns a package's *shared* dependencies to
    // the same manual chunk, so `@react-three/fiber`'s copy of zustand landed in
    // the "three" chunk; every eagerly-loaded store then statically imported
    // that chunk and pulled all ~1.2 MB of Three.js into the boot path.
    //
    // What actually splits the bundle is the lazy() boundaries — see main.tsx
    // (popout views), DetailPanel (PROJECT tab, AI POPUPS) and App.tsx (routes)
    // — plus keeping Three-free metadata out of Three-importing modules
    // (robotPalette.ts, robotModelMeta.ts, roomGrid.ts). Rollup then derives the
    // chunks from real reachability. Verify with:
    //   node -e "…" on dist/client/assets/index-*.js to list its static imports.
  },
  optimizeDeps: {
    // latex.js dynamically requires `./packages/<name>` and `./documentclasses/<name>`
    // at runtime; esbuild's pre-bundler glob-includes the directories and trips on
    // their empty `.keep` sentinel files. Skip pre-bundling — we already lazy-import
    // it, so it loads on demand without the optimizer.
    exclude: ['latex.js'],
  },
});
