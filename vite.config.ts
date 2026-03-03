import { defineConfig, createLogger } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

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
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
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
  },
});
