// The Full Client package: Full's UI, and no server. See electron-builder.client-base.cjs.
module.exports = require('./electron-builder.client-base.cjs')({
  edition: 'full-client',
  productName: 'AI Agent Session Center Full Client',
  uiFolder: 'dist/client',
  icon: 'icon-client',
});
