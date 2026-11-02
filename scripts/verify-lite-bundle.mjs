#!/usr/bin/env node
// Fails the Lite build when its UI still carries what Lite hides, or lost what it must keep.
// A hidden route that stays in the bundle costs size without showing anywhere, and a lost
// phone chunk only shows up on a paired phone, so neither would be noticed by looking at the app.
//   node scripts/verify-lite-bundle.mjs [client-folder]   (default dist/client-lite)
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DROPPED = ['CyberdromeScene', 'AgendaView', 'PromptsView', 'QueueView', 'ReviewView', 'ResourcesView'];
const KEPT = ['HistoryView', 'PhoneAppFrame', 'ProjectTab'];

const folder = resolve(process.argv[2] ?? 'dist/client-lite');
let chunks;
try {
  chunks = readdirSync(join(folder, 'assets')).filter((name) => name.endsWith('.js'));
} catch {
  console.error(`No Lite build in ${folder}. Run: npm run build:lite`);
  process.exit(1);
}

const chunkOf = (name) => (chunk) => chunk.startsWith(`${name}-`);
const stayed = DROPPED.flatMap((name) => chunks.filter(chunkOf(name)));
const lost = KEPT.filter((name) => !chunks.some(chunkOf(name)));

for (const chunk of stayed) console.error(`Lite still contains ${chunk}. Its import must be dropped when IS_LITE is true.`);
for (const name of lost) console.error(`Lite lost its ${name} chunk. HISTORY, PROJECT and a paired phone need it.`);
if (stayed.length > 0 || lost.length > 0) process.exit(1);

console.log(`Lite bundle OK: ${chunks.length} chunks, none of ${DROPPED.join(', ')}.`);
