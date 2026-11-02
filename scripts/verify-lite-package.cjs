// electron-builder afterPack hook: fails the Lite build when a library it should have left out is still packed.
// A wrong `files` order keeps them all with no warning, and the app still works, only at Full's size.
const { closeSync, openSync, readSync } = require('node:fs');
const path = require('node:path');

function leftOutLibraries() {
  return require('../electron-builder.lite.cjs').files
    .filter((entry) => typeof entry === 'string' && entry.startsWith('!node_modules/'))
    .map((entry) => entry.replace('!node_modules/', '').replace('/**', ''));
}

function readAsarHeader(asar) {
  const fd = openSync(asar, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12));
    readSync(fd, json, 0, json.length, 16);
    return JSON.parse(json.toString());
  } finally {
    closeSync(fd);
  }
}

function librariesStillPacked(asar, libraries) {
  const modules = readAsarHeader(asar).files.node_modules;
  return libraries.filter((library) => {
    let node = modules;
    for (const part of library.split('/')) node = node?.files?.[part];
    return node !== undefined;
  });
}

function asarPath({ appOutDir, electronPlatformName, packager }) {
  return electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app.asar')
    : path.join(appOutDir, 'resources', 'app.asar');
}

async function afterPack(context) {
  const stillPacked = librariesStillPacked(asarPath(context), leftOutLibraries());
  if (stillPacked.length > 0) {
    throw new Error(`The Lite package still contains ${stillPacked.join(', ')}. Check the order of "files" in electron-builder.lite.cjs.`);
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.leftOutLibraries = leftOutLibraries;
module.exports.librariesStillPacked = librariesStillPacked;
module.exports.asarPath = asarPath;
