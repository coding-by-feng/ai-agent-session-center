import { mergeConfig } from 'vite';
import base from './vite.config';

/**
 * A Client edition's home page (src/client-home), the one page a Client serves as itself. Both Clients carry the same
 * one. No public folder: `static/` holds the dashboard's screenshots and videos, which this page never shows.
 */
export default mergeConfig(base, {
  publicDir: false,
  build: {
    outDir: 'dist/client-home',
    emptyOutDir: true,
    rollupOptions: { input: 'client-home.html' },
  },
});
