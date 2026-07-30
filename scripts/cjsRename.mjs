/**
 * Renames dist/electron/**\/*.js → .cjs and fixes require paths.
 * Needed because root package.json has "type":"module" but Electron
 * main process is compiled to CJS by tsconfig.electron.json.
 * Using .cjs extension is always CJS regardless of package.json type,
 * and avoids creating a dist/electron/package.json that breaks
 * Electron's built-in require('electron') resolution.
 *
 * Pure Node (no bash/sed) so it runs identically on macOS, Linux, and
 * Windows CI runners — the previous shell version relied on BSD `sed -i ''`,
 * which is a different, incompatible flag under GNU sed.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

const DIR = 'dist/electron';

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

const files = walk(DIR);

for (const file of files) {
  if (!file.endsWith('.js')) continue;
  const original = readFileSync(file, 'utf8');
  // Fix require paths: only replace .js" when preceded by a path separator (/).
  // This matches require("./module.js") but not standalone filename strings.
  const updated = original
    .replace(/\/([^"]*)\.js"\)/g, '/$1.cjs")')
    .replace(/\.js\.map/g, '.cjs.map');
  if (updated !== original) writeFileSync(file, updated);
}

for (const file of files) {
  if (file.endsWith('.js.map')) {
    renameSync(file, file.slice(0, -'.js.map'.length) + '.cjs.map');
  } else if (file.endsWith('.js')) {
    renameSync(file, file.slice(0, -'.js'.length) + '.cjs');
  }
}
