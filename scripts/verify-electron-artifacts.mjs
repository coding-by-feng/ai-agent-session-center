import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const platform = process.argv[2] ?? { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
const directory = path.resolve(process.argv[3] ?? 'dist');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const { productName } = JSON.parse(await readFile('electron-builder.json', 'utf8'));
const artifacts = {
  mac: [`${productName}-${pkg.version}-arm64.dmg`, `${productName}-${pkg.version}-arm64-mac.zip`],
  win: [`${productName} Setup ${pkg.version}.exe`],
  linux: [`${pkg.name}-${pkg.version}-x64.AppImage`, `${pkg.name}-${pkg.version}-x64.deb`],
};

if (!Object.hasOwn(artifacts, platform)) {
  throw new Error('Choose mac, win or linux: npm run electron:verify -- <platform> [artifact-directory]');
}

const checksumPath = path.join(directory, `SHA256SUMS-${platform}.txt`);
// A failed re-verification must not leave a previous success manifest behind.
await rm(checksumPath, { force: true });
const lines = [];
for (const name of artifacts[platform]) {
  const filename = path.join(directory, name);
  const info = await stat(filename);
  if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty artifact: ${filename}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  const digest = hash.digest('hex');
  lines.push(`${digest}  ${name}\n`);
  console.log(`${filename} (${info.size} bytes) SHA-256 ${digest}`);
}
await writeFile(checksumPath, lines.join(''));
console.log(`Verified ${platform} ${pkg.version}; checksums: ${checksumPath}`);
