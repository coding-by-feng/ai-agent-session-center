// electron-builder afterPack hook, which runs before signing. It fails a Client build that carries anything local, or
// lacks what it needs: a wrong `files` entry does neither loudly, since the app would still run, at Full's size, or open
// to a blank window. Then it sets the Client's fuses.
const { FuseV1Options, FuseVersion, flipFuses } = require('@electron/fuses');
const { closeSync, openSync, readSync } = require('node:fs');
const { builtinModules } = require('node:module');
const path = require('node:path');

/**
 * Baked into the Electron binary. The first three let any local program run its own code as this app, with this app's
 * keychain access; a Client needs none of them, and without them the keychain's protection of its cookies means
 * something. Cookie encryption can't be turned off later without losing every sign-in, so it starts on. Inspect off
 * also means Playwright's `_electron` can't drive a shipped Client: see client-editions.md.
 */
const CLIENT_FUSES = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
};

const ENTRY_POINTS = ['dist/electron/clientMain.cjs', 'dist/electron/preloadClient.cjs'];

const MUST_NOT_CARRY = [
  'dist/server-bundle.cjs', 'server', 'hooks', 'node_modules/node-pty', 'node_modules/better-sqlite3',
  'dist/electron/main.cjs', 'dist/electron/preload.cjs', 'dist/electron/ptyHost.cjs', 'dist/electron/tray.cjs',
];
const MUST_CARRY = [
  'dist/electron/clientMain.cjs', 'dist/electron/preloadClient.cjs',
  'dist/client/index.html', 'dist/client-home/client-home.html',
];

function has(header, file) {
  let node = header;
  for (const part of file.split('/')) node = node?.files?.[part];
  return node !== undefined;
}

function clientPackageProblems(header) {
  return [
    ...MUST_NOT_CARRY.filter((file) => has(header, file)).map((file) => `carries ${file}`),
    ...MUST_CARRY.filter((file) => !has(header, file)).map((file) => `is missing ${file}`),
  ];
}

/**
 * Everything the packed code loads that isn't packed. A shared module that later imports something a Client leaves out
 * passes every test, then stops the packaged app at launch with `Cannot find module`.
 */
function unpackedRequires(entries, header, read) {
  const builtin = new Set(['electron', ...builtinModules]);
  const seen = new Set();
  const problems = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, name] of read(file).matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
      if (!name.startsWith('.')) {
        if (!builtin.has(name.replace(/^node:/, ''))) problems.push(`${file} loads ${name}, and a Client carries no npm packages`);
        continue;
      }
      const target = path.posix.join(path.posix.dirname(file), name);
      if (has(header, target)) walk(target);
      else problems.push(`${file} loads ${target}, which isn't packed`);
    }
  };
  entries.forEach(walk);
  return problems;
}

function readAsar(asar) {
  const fd = openSync(asar, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12));
    readSync(fd, json, 0, json.length, 16);
    const header = JSON.parse(json.toString());
    const filesStart = 8 + head.readUInt32LE(4);
    const read = (file) => {
      let node = header;
      for (const part of file.split('/')) node = node.files[part];
      const body = Buffer.alloc(Number(node.size));
      readSync(fd, body, 0, body.length, filesStart + Number(node.offset));
      return body.toString('utf8');
    };
    return { header, read, close: () => closeSync(fd) };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

function asarPath({ appOutDir, electronPlatformName, packager }) {
  return electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app.asar')
    : path.join(appOutDir, 'resources', 'app.asar');
}

/** Where each platform's packager put the app: only Linux names its executable apart from the product. */
function electronBinary({ appOutDir, electronPlatformName, packager }) {
  const { productFilename } = packager.appInfo;
  if (electronPlatformName === 'darwin') return path.join(appOutDir, `${productFilename}.app`);
  if (electronPlatformName === 'win32') return path.join(appOutDir, `${productFilename}.exe`);
  return path.join(appOutDir, packager.executableName);
}

async function afterPack(context) {
  const asar = readAsar(asarPath(context));
  let problems;
  try {
    problems = clientPackageProblems(asar.header);
    if (problems.length === 0) problems = unpackedRequires(ENTRY_POINTS, asar.header, asar.read);
  } finally {
    asar.close();
  }
  if (problems.length > 0) {
    throw new Error(`The Client package ${problems.join(', ')}. Check "files" in electron-builder.client-base.cjs.`);
  }
  // Flipping a fuse edits the binary, so an Apple Silicon build needs a signature it can start with. Signing follows.
  await flipFuses(electronBinary(context), {
    ...CLIENT_FUSES,
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin' && process.platform === 'darwin',
  });
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.CLIENT_FUSES = CLIENT_FUSES;
module.exports.electronBinary = electronBinary;
module.exports.clientPackageProblems = clientPackageProblems;
module.exports.unpackedRequires = unpackedRequires;
