import express, { type Express, type Request, type Response } from 'express';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

/** Both interfaces share API/WS and authentication, never a second runtime. */
export function mountHostedUi(
  app: Express,
  options: { root: string; websiteOrigin: string },
): void {
  for (const edition of ['lite', 'full'] as const) {
    const prefix = `/ui/${edition}`;
    const directory = join(options.root, edition);
    const index = async (_req: Request, res: Response) => {
      try {
        const html = await readFile(join(directory, 'index.html'), 'utf8');
        res.setHeader('Cache-Control', 'no-store');
        res
          .type('html')
          .send(
            html.replace(
              '<head>',
              `<head><meta name="aasc-hosted-parent" content="${options.websiteOrigin}"><meta name="aasc-ui-base" content="${prefix}">`,
            ),
          );
      } catch {
        res
          .status(503)
          .type('text')
          .send(
            `${edition === 'full' ? 'Full' : 'Lite'} interface is unavailable. Your workspace is unchanged. Please retry or use the other interface.`,
          );
      }
    };
    app.get([prefix, prefix + '/', prefix + '/index.html'], index);
    app.use(prefix, express.static(directory, { index: false }));
    app.use(prefix + '/assets', (_req, res) => {
      res.status(404).end();
    });
    app.get(prefix + '/{*path}', index);
  }
  app.use('/ui', (_req, res) => {
    res.status(404).end();
  });
}

/** Check each entry and the local JS/CSS it actually references; never execute a model call. */
export async function hostedUiReadiness(root?: string): Promise<{ lite: boolean; full: boolean }> {
  async function ready(edition: string) {
    if (!root) return false;
    try {
      const html = await readFile(join(root, edition, 'index.html'), 'utf8');
      const references = [
        ...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g),
      ].map((m) => m[1].split('?')[0]);
      if (!references.some((p) => p.endsWith('.js'))) return false;
      for (const value of references) {
        const relative = value.replace(`/ui/${edition}/`, '').replace(/^\.\//, '');
        if (!relative.startsWith('assets/') || relative.includes('..') || relative.includes('\\'))
          return false;
        await access(join(root, edition, relative));
      }
      return true;
    } catch {
      return false;
    }
  }
  const [lite, full] = await Promise.all([ready('lite'), ready('full')]);
  return { lite, full };
}
