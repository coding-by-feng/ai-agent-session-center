// The Lite Client package: Lite's UI, and no server. See electron-builder.client-base.cjs.
module.exports = require('./electron-builder.client-base.cjs')({
  edition: 'lite-client',
  productName: 'AI Agent Session Center Lite Client',
  uiFolder: 'dist/client-lite',
  icon: 'icon-lite-client',
});
