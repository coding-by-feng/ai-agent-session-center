// What the two Client packages share: Full's platform settings without anything that runs locally. A Client carries a
// UI, a home page and the small main process that shows another computer's AASC.
const base = require('./electron-builder.json');

// The local app's own modules, which a Client never loads. tsc builds them all into dist/electron. ptyHost, ptyRing and
// ipc/terminalHandlers were removed in Nov 2026; they stay listed so a stale build output in dist/electron never ships.
const LOCAL_MODULES = ['main', 'preload', 'ptyHost', 'tray', 'ptyRing', 'portPreflight', 'edition', 'popoutBounds', 'internalUrl', 'ipc/setupHandlers', 'ipc/appHandlers', 'ipc/terminalHandlers'];

module.exports = function clientConfig({ edition, productName, uiFolder, icon }) {
  const packageName = `ai-agent-session-center-${edition}`;
  return {
    ...base,
    appId: `${base.appId}.${edition}`,
    productName,
    directories: { output: `dist/${edition}` },
    // The package name decides the data folder and keychain item: see electron/clientEdition.ts.
    extraMetadata: {
      ...base.extraMetadata,
      name: 'ai-agent-session-center-client',
      main: 'dist/electron/clientMain.cjs',
      aascEdition: edition,
    },
    // The exclusions must stay ahead of the { from, to } entries. electron-builder groups each run of strings into
    // one set, and a later set can add back what an earlier one left out.
    files: [
      'dist/electron/**',
      ...LOCAL_MODULES.flatMap((name) => [`!dist/electron/${name}.cjs`, `!dist/electron/${name}.cjs.map`]),
      '!dist/electron/loading.html',
      '!node_modules/**',
      { from: uiFolder, to: 'dist/client' },
      { from: 'dist/client-home', to: 'dist/client-home' },
    ],
    asarUnpack: [],
    extraResources: [],
    afterPack: 'scripts/verify-client-package.cjs',
    dmg: { ...base.dmg, title: productName },
    mac: {
      ...base.mac,
      icon: `electron/icon/${icon}.icns`,
      // Full's list adds Apple Events and loading other people's libraries, which a window on another computer never needs.
      entitlements: 'electron/entitlements.client.mac.plist',
      entitlementsInherit: 'electron/entitlements.client.mac.plist',
    },
    win: { ...base.win, icon: `electron/icon/${icon}.ico` },
    linux: {
      ...base.linux,
      icon: `electron/icon/${icon}.icns`,
      artifactName: `${packageName}-\${version}-\${arch}.\${ext}`,
      executableName: packageName,
    },
    deb: { packageName },
  };
};
