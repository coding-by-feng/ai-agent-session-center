import { mergeConfig } from 'vite';
import base from './vite.config';

const edition = process.env.AASC_HOSTED_UI;
if (edition !== 'lite' && edition !== 'full')
  throw new Error('AASC_HOSTED_UI must be lite or full');
export default mergeConfig(base, {
  base: `/ui/${edition}/`,
  define: { __AASC_EDITION__: JSON.stringify(edition) },
  build: { outDir: `dist/hosted/${edition}` },
});
