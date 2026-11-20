// The dev shell's fake AASC Cloud account: the directory of its computers (GET /v1/machines, plan 18), which only
// adds address hints to the Macs the account lists, and the query switches that make it answer like an older
// backend or an older sign-in.
import { describe, expect, it } from 'vitest';
import { enrollViaAccount } from '../accountEnroll';
import { listAccountMacs, withDirectoryHints } from '../accountMacs';
import { signInWithGoogle } from '../accountSignIn';
import type { HttpRequest } from '../http';
import { devDeps } from './dev';

const MBP = '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f';
const MACHINES = 'GET https://api.aasc.work/v1/machines';
const MACS = 'GET https://api.aasc.work/v1/enroll/macs';

/** The dev shell opened with `search`, signed in to its fake account; `asked` is every request from then on. */
async function signedIn(search: string) {
  const dev = await devDeps(search);
  const signIn = await signInWithGoogle(dev, 'Dev phone');
  if (!signIn.ok) throw new Error(signIn.message);
  const asked: string[] = [];
  const deps = {
    ...dev,
    requester: {
      request: (req: HttpRequest) => {
        asked.push(`${req.method} ${req.url}`);
        return dev.requester.request(req);
      },
    },
  };
  return { deps, asked };
}

/** The account's Macs as "Your Macs" holds them: the list, then the directory's hints for it. */
async function yourMacs(deps: Awaited<ReturnType<typeof signedIn>>['deps']) {
  const out = await listAccountMacs(deps);
  if (out.status !== 'ok') throw new Error(out.status);
  return { listed: out.macs, hinted: await withDirectoryHints(deps, out.macs) };
}

describe('the dev shell’s account directory', () => {
  it('answers the directory, which has nothing to add to the fake account’s Mac by default', async () => {
    const { deps, asked } = await signedIn('');
    const { listed, hinted } = await yourMacs(deps);
    expect(listed).toEqual([expect.objectContaining({ deviceId: MBP, name: 'Kason-MBP', lan: null, tailnet: '100.101.102.103', port: 3333 })]);
    expect(hinted).toBe(listed);
    expect(asked).toEqual([MACS, MACHINES]);
  });

  it('?scenario=lan: the directory hints at the home-network address, and Connect enrolls over it', async () => {
    const { deps } = await signedIn('?scenario=lan');
    const { listed, hinted } = await yourMacs(deps);
    expect(listed[0]).toMatchObject({ deviceId: MBP, lan: null, tailnet: '100.101.102.103', port: 3333 });
    expect(hinted[0]).toMatchObject({ deviceId: MBP, lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333 });
    const out = await enrollViaAccount(deps, [], hinted[0], { phoneName: 'Dev phone' });
    if (!out.ok) throw new Error(out.message);
    expect(out.mac).toMatchObject({ lan: '192.168.1.20', tailnet: null, lanAllowed: true, lastPath: 'lan' });
  });

  it.each(['forbidden', 'absent'])('?scenario=lan&directory=%s: no hint, so nothing reaches the Mac at home', async (mode) => {
    const { deps, asked } = await signedIn(`?scenario=lan&directory=${mode}`);
    const { listed, hinted } = await yourMacs(deps);
    expect(hinted).toBe(listed);
    expect(listed[0]).toMatchObject({ deviceId: MBP, lan: null });
    expect(asked).toEqual([MACS, MACHINES]);
    expect(await enrollViaAccount(deps, [], hinted[0], { phoneName: 'Dev phone' })).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('an unknown ?directory value is a directory that answers', async () => {
    const { deps } = await signedIn('?scenario=lan&directory=nonsense');
    const { hinted } = await yourMacs(deps);
    expect(hinted[0]).toMatchObject({ lan: '192.168.1.20' });
  });

  it('by default the Mac enrolls over its Tailscale address, as before the directory existed', async () => {
    const { deps, asked } = await signedIn('');
    const { hinted } = await yourMacs(deps);
    asked.length = 0;
    const out = await enrollViaAccount(deps, [], hinted[0], { phoneName: 'Dev phone' });
    if (!out.ok) throw new Error(out.message);
    expect(out.mac).toMatchObject({ lan: null, tailnet: '100.101.102.103', lanAllowed: false, lastPath: 'tailnet' });
    expect(asked.some((line) => line.includes('192.168.1.20'))).toBe(false);
  });
});
