// Notarize and staple Mac disk images after `electron-builder` has signed them (dmg.sign in electron-builder.json).
// electron-builder notarizes the .app inside but not the .dmg around it; without this, Gatekeeper rejects the
// downloaded disk image itself ("no usable signature"). Stapling rewrites the DMG, so run it BEFORE
// `npm run electron:verify` writes checksums.
//
//   node scripts/notarize-mac-dmg.mjs <file.dmg> [more.dmg…]
//
// Credentials: the notarytool keychain profile in APPLE_KEYCHAIN_PROFILE (default `aasc-notary`).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const dmgs = process.argv.slice(2);
if (dmgs.length === 0) throw new Error('Usage: node scripts/notarize-mac-dmg.mjs <file.dmg> [more.dmg…]');
if (process.platform !== 'darwin') throw new Error('Notarization needs macOS (xcrun notarytool).');
const profile = process.env.APPLE_KEYCHAIN_PROFILE || 'aasc-notary';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// codesign, spctl and stapler report on stderr even when they succeed, so read both streams.
const runAll = (cmd, args) => {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
};

for (const dmg of dmgs) {
  if (!dmg.endsWith('.dmg') || !existsSync(dmg)) throw new Error(`Not a disk image: ${dmg}`);
  const signature = runAll('codesign', ['-dv', '--verbose=2', dmg]);
  const authority = /Authority=(Developer ID Application: .+)/.exec(signature)?.[1];
  if (!authority) throw new Error(`${dmg} is not signed with a Developer ID (dmg.sign off, or CSC_NAME unset):\n${signature}`);
  console.log(`${dmg}: signed by ${authority}; submitting to Apple…`);

  const submit = runAll('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait']);
  if (!/status: Accepted/.test(submit)) throw new Error(`Apple did not accept ${dmg}:\n${submit}`);
  console.log(submit.trim().split('\n').filter((line) => /id:|status:/.test(line)).join('\n'));

  run('xcrun', ['stapler', 'staple', dmg]);
  const validate = runAll('xcrun', ['stapler', 'validate', dmg]);
  if (!/worked/.test(validate)) throw new Error(`Stapled ticket does not validate on ${dmg}:\n${validate}`);
  const gatekeeper = runAll('spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv', dmg]);
  if (!/accepted/.test(gatekeeper) || !/Notarized Developer ID/.test(gatekeeper)) {
    throw new Error(`Gatekeeper does not accept ${dmg}:\n${gatekeeper}`);
  }
  console.log(`${dmg}: notarized, stapled, Gatekeeper accepts it`);
}
