// The Lite package: Full's configuration, with its own app name and ID, the Lite UI, and without the
// libraries only the hidden features load. The package `name` stays Full's on purpose: Electron derives the
// data folder and the keychain item from it, so both editions share settings, sessions and cloud sign-in.
const base = require('./electron-builder.json');

const productName = 'AI Agent Session Center Lite';
const LEFT_OUT = ['three', 'three-stdlib', 'stats-gl', 'hls.js', '@mediapipe/tasks-vision', 'pdfjs-dist', 'latex.js'];

module.exports = {
  ...base,
  appId: `${base.appId}.lite`,
  productName,
  directories: { output: 'dist/lite' },
  extraMetadata: { ...base.extraMetadata, aascEdition: 'lite' },
  // The exclusions must stay ahead of the { from, to } entry. electron-builder groups each run of strings into
  // one set, and a later set lands before `node_modules/**`, which then adds every library back.
  files: [
    ...base.files.filter((entry) => entry !== 'dist/client/**'),
    ...LEFT_OUT.map((library) => `!node_modules/${library}/**`),
    { from: 'dist/client-lite', to: 'dist/client' },
  ],
  afterPack: 'scripts/verify-lite-package.cjs',
  dmg: { ...base.dmg, title: productName },
  // The same robot as Full with a green keyboard, so the two can be told apart when both are installed.
  // Linux converts the .icns, as Full's does through mac.icon; stated so it can't follow a change to mac.
  mac: { ...base.mac, icon: 'electron/icon/icon-lite.icns' },
  win: { ...base.win, icon: 'electron/icon/icon-lite.ico' },
  linux: {
    ...base.linux,
    icon: 'electron/icon/icon-lite.icns',
    artifactName: 'ai-agent-session-center-lite-${version}-${arch}.${ext}',
    executableName: 'ai-agent-session-center-lite',
  },
  deb: { packageName: 'ai-agent-session-center-lite' },
};
