import {describe,it,expect} from 'vitest';
import {readRemotePairingLink} from '../electron/remote/pairingLinkRules.js';
import {addressPlan} from '../electron/remote/remoteClient.js';
const origin='https://order-da1537bb1cac4015a4fff9c980c36eaf.aasc.work';
describe('hosted desktop pairing',()=>{
 it('parses a hosted HTTPS link and connects only to its exact TLS origin',()=>{
  const r=readRemotePairingLink('https://aasc.work/pair#v=2&name=VPS&p=443&mc=ABCDEFGH23&https='+encodeURIComponent(origin));
  expect(r.ok).toBe(true);if(!r.ok)return;
  expect(addressPlan(r.link)).toEqual([{via:'https',origin}]);
 });
 it.each(['http://order-a.lite.xclaude.dev','https://evil.example','https://order-a.lite.xclaude.dev.evil.example','https://user@order-a.lite.xclaude.dev','https://order-a.lite.xclaude.dev/path','https://order-a.lite.xclaude.dev:444','https://127.0.0.1','https://lite.xclaude.dev'])('refuses unreviewed or ambiguous hosted origin %s',origin=>{
  expect(readRemotePairingLink('v=2&name=VPS&p=443&mc=ABCDEFGH23&https='+encodeURIComponent(origin)).ok).toBe(false);
 });
 it('does not downgrade HTTPS pairing to an injected LAN address',()=>{
  expect(readRemotePairingLink('v=2&name=VPS&p=443&mc=ABCDEFGH23&https='+encodeURIComponent(origin)+'&lan=192.168.1.2').ok).toBe(false);
 });
});
