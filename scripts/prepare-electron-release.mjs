import { execFileSync } from 'node:child_process';
import { readFile, mkdir, link, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (!process.argv[2]) throw new Error('Usage: node scripts/prepare-electron-release.mjs <build-directory-with-mac-win-linux>');
const root = path.resolve(process.argv[2]);
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const platforms = ['mac', 'win', 'linux'];
const verified = [];
// Verify the entire set before creating an upload directory; a missing platform cannot become a partial release.
for (const platform of platforms) {
  const directory = path.join(root, platform);
  execFileSync(process.execPath, ['scripts/verify-electron-artifacts.mjs', platform, directory], { stdio: 'inherit' });
  const lines = (await readFile(path.join(directory, `SHA256SUMS-${platform}.txt`), 'utf8')).trim().split('\n');
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match || path.basename(match[2]) !== match[2]) throw new Error(`Invalid checksum entry for ${platform}`);
    verified.push({ platform, source: path.join(directory, match[2]), name: match[2].replaceAll(' ', '.'), sha256: match[1] });
  }
}
if (verified.length !== 5 || new Set(verified.map(file => file.name)).size !== 5) throw new Error('Expected five distinct release binaries');
const upload = path.join(root, 'upload');
await mkdir(upload); // A version's staged assets are immutable; never silently mix in a previous run.
const assets = [];
for (const file of verified) {
  const filename = path.join(upload, file.name);
  await link(file.source, filename); // Same-volume hard links avoid duplicating hundreds of MB.
  assets.push({ ...file, path: filename, bytes: (await stat(filename)).size });
}
for (const platform of platforms) {
  await writeFile(path.join(upload, `SHA256SUMS-${platform}.txt`), verified.filter(file => file.platform === platform).map(file => `${file.sha256}  ${file.name}\n`).join(''));
}
await writeFile(path.join(root, 'release-assets.json'), JSON.stringify({ version, upload, assets }, null, 2) + '\n');
console.log(`Ready to publish ${version}: five binaries and three checksum files in ${upload}`);
