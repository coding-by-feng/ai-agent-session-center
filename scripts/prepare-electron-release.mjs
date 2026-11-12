import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, link, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (!process.argv[2]) throw new Error('Usage: node scripts/prepare-electron-release.mjs <build-directory with <edition->mac|win|linux folders for full, lite, full-client and lite-client>');
const root = path.resolve(process.argv[2]);
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const platforms = ['mac', 'win', 'linux'];
// Every release ships four editions on three platforms. Full's folder and checksum file carry no edition name.
const editions = ['full', 'lite', 'full-client', 'lite-client'];
const sets = editions.flatMap(edition => platforms.map(platform => edition === 'full'
  ? { platform, edition, folder: platform, checksums: `SHA256SUMS-${platform}.txt` }
  : { platform, edition, folder: `${edition}-${platform}`, checksums: `SHA256SUMS-${platform}-${edition}.txt` }));
const BINARIES = editions.length * 5; // per edition: Mac dmg + zip, Windows exe, Linux AppImage + deb
const verified = [];
// Verify the entire set before creating an upload directory; a missing platform or edition cannot become a partial release.
for (const { platform, edition, folder, checksums } of sets) {
  const directory = path.join(root, folder);
  execFileSync(process.execPath, ['scripts/verify-electron-artifacts.mjs', platform, directory, edition], { stdio: 'inherit' });
  const lines = (await readFile(path.join(directory, checksums), 'utf8')).trim().split('\n');
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match || path.basename(match[2]) !== match[2]) throw new Error(`Invalid checksum entry for ${folder}`);
    verified.push({ platform, edition, checksums, source: path.join(directory, match[2]), name: match[2].replaceAll(' ', '.'), sha256: match[1] });
  }
}
if (verified.length !== BINARIES || new Set(verified.map(file => file.name)).size !== BINARIES) throw new Error(`Expected ${BINARIES} distinct release binaries`);
const upload = path.join(root, 'upload');
await mkdir(upload); // A version's staged assets are immutable; never silently mix in a previous run.
const assets = [];
for (const file of verified) {
  const filename = path.join(upload, file.name);
  await link(file.source, filename); // Same-volume hard links avoid duplicating hundreds of MB.
  assets.push({ ...file, path: filename, bytes: (await stat(filename)).size });
}
for (const { checksums } of sets) {
  await writeFile(path.join(upload, checksums), verified.filter(file => file.checksums === checksums).map(file => `${file.sha256}  ${file.name}\n`).join(''));
}

// The Mac auto-updater (electron/autoUpdate.ts, Full and Lite only: the Clients have none) reads `latest-mac.yml` (Full) or `lite-mac.yml` (Lite) from the
// latest release and downloads the zip it names. Written here, not taken from electron-builder: its copy names the
// zip with dashes, but GitHub serves it with dots, and the DMG is stapled after the build, so only the staged bytes
// and public names are trustworthy.
async function sha512(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}
const updateFiles = [];
for (const { edition, file } of [{ edition: 'full', file: 'latest-mac.yml' }, { edition: 'lite', file: 'lite-mac.yml' }]) {
  const zip = assets.find(asset => asset.platform === 'mac' && asset.edition === edition && asset.name.endsWith('-arm64-mac.zip'));
  if (!zip) throw new Error(`No Mac zip for ${edition}: the auto-update file needs one`);
  const digest = await sha512(zip.path);
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${zip.name}`,
    `    sha512: ${digest}`,
    `    size: ${zip.bytes}`,
    `path: ${zip.name}`,
    `sha512: ${digest}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n');
  await writeFile(path.join(upload, file), yml);
  updateFiles.push({ edition, file, zip: zip.name, sha512: digest });
}
await writeFile(path.join(root, 'release-assets.json'), JSON.stringify({ version, upload, assets, updateFiles }, null, 2) + '\n');
console.log(`Ready to publish ${version}: ${BINARIES} binaries, ${sets.length} checksum files and two Mac update files in ${upload}`);
