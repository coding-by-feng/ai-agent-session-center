// DevicePresenceChip.host.test.ts — where the devices panel lives while the Header is hidden.
//
// A session panel in view takes the Header, and the devices chip with it, off the screen (App's `hideTopBars`).
// That is when the `switchDevice` key is pressed from a terminal, so App mounts a chip-less copy in the Header's
// place. What that copy does is in DevicePresenceChip.switchKeys.cases.tsx; this pins that App still mounts it, in
// that branch and no other, and that the chip stays out of a lazy chunk there (it is already eager through Header).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const app = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');
const from = app.indexOf('{hideTopBars ? (');
// `<main ` with its attributes: a comment above also says "<main>".
const branches = app.slice(from, app.indexOf('<main ', from));
const [whenHidden, whenShown] = branches.split(') : (');

describe('App — the devices panel while a session panel hides the Header', () => {
  it('reads the branch it means to', () => {
    expect(whenHidden).toContain('titleBarSpacer');
    expect(whenShown).toContain('<Header />');
  });

  it('mounts the chip-less copy in the Header’s place, and only there', () => {
    expect(whenHidden).toContain('<DevicePresenceChip chipless />');
    expect(whenShown).not.toContain('DevicePresenceChip');
    expect(app.match(/<DevicePresenceChip\b/g)).toHaveLength(1);
  });

  it('imports it statically: Header already does, so it is in the entry chunk either way', () => {
    expect(app).toMatch(/^import DevicePresenceChip from '@\/components\/layout\/DevicePresenceChip';$/m);
    const header = readFileSync(resolve(__dirname, 'Header.tsx'), 'utf8');
    expect(header).toMatch(/^import DevicePresenceChip from '\.\/DevicePresenceChip';$/m);
    expect(app).toMatch(/^import Header from '@\/components\/layout\/Header';$/m);
  });
});
