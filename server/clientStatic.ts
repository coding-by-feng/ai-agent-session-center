// clientStatic.ts — serves the built React app (dist/client).
//
// A hashed build file that isn't there is a 404, never the SPA fallback's index.html. A page
// still running an older build (the phone app left in the background while this Mac's AASC was
// updated) asks for its old chunk names; as HTML they fail as a "module" with a MIME error.
// The page's chunk-reload guard (src/lib/chunkReload.ts) reloads once and picks up the new build.
import express, { type Express } from 'express';

export function mountClientStatic(app: Express, clientDir: string): void {
  app.use(express.static(clientDir));
  app.use('/assets', (_req, res) => {
    res.status(404).end();
  });
}
