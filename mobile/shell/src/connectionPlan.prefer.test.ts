// connectionPlan.prefer.test.ts — every path is tried at once and the home network wins when it answers in time
// (Nov 10 2026: an iPhone at home opened its Mac over a relayed Tailscale link and sat on "Loading...").
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAN_GRACE_MS, pickPreferred, type Candidate } from './connectionPlan';

const LAN: Candidate = { kind: 'lan', origin: 'http://192.168.1.20:3333', encrypted: false };
const TS: Candidate = { kind: 'tailnet', origin: 'http://100.101.102.103:3333', encrypted: true };

/** A probe whose answer for each origin comes after `ms` (true/false), or never (`'hang'`). */
function probeAfter(plan: Record<string, [number, boolean] | 'hang'>) {
  const started: string[] = [];
  const probe = (origin: string): Promise<boolean> => {
    started.push(origin);
    const step = plan[origin];
    if (step === 'hang') return new Promise(() => undefined);
    return new Promise((resolve) => setTimeout(() => resolve(step[1]), step[0]));
  };
  return { probe, started };
}

afterEach(() => vi.useRealTimers());

describe('pickPreferred', () => {
  it('tries every path at once', async () => {
    vi.useFakeTimers();
    const { probe, started } = probeAfter({ [LAN.origin]: [50, true], [TS.origin]: [20, true] });
    const picked = pickPreferred([LAN, TS], probe);
    expect(started).toEqual([LAN.origin, TS.origin]);
    await vi.advanceTimersByTimeAsync(50);
    await expect(picked).resolves.toBe(LAN);
  });

  it('takes the home network even when Tailscale answered first, if it answers within the grace', async () => {
    vi.useFakeTimers();
    const { probe } = probeAfter({ [LAN.origin]: [LAN_GRACE_MS - 100, true], [TS.origin]: [10, true] });
    let picked: Candidate | null | undefined;
    void pickPreferred([LAN, TS], probe).then((c) => { picked = c; });
    await vi.advanceTimersByTimeAsync(LAN_GRACE_MS - 50);
    expect(picked).toBe(LAN);
  });

  it('takes Tailscale once the home network has had its grace and still not answered', async () => {
    vi.useFakeTimers();
    const { probe } = probeAfter({ [LAN.origin]: 'hang', [TS.origin]: [100, true] });
    let picked: Candidate | null | undefined;
    void pickPreferred([LAN, TS], probe).then((c) => { picked = c; });
    await vi.advanceTimersByTimeAsync(100 + LAN_GRACE_MS - 1);
    expect(picked).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(picked).toBe(TS);
  });

  it('takes Tailscale at once when the home network says no', async () => {
    vi.useFakeTimers();
    const { probe } = probeAfter({ [LAN.origin]: [30, false], [TS.origin]: [100, true] });
    let picked: Candidate | null | undefined;
    void pickPreferred([LAN, TS], probe).then((c) => { picked = c; });
    await vi.advanceTimersByTimeAsync(100);
    expect(picked).toBe(TS);
  });

  it('a probe that throws counts as no answer', async () => {
    const picked = await pickPreferred([LAN, TS], async (o) => {
      if (o === LAN.origin) throw new Error('unreachable');
      return true;
    });
    expect(picked).toBe(TS);
  });

  it('null when nothing answers, and for no paths at all', async () => {
    await expect(pickPreferred([LAN, TS], async () => false)).resolves.toBeNull();
    await expect(pickPreferred([], async () => true)).resolves.toBeNull();
  });

  it('names the path it is waiting on, in order', async () => {
    vi.useFakeTimers();
    const { probe } = probeAfter({ [LAN.origin]: [30, false], [TS.origin]: [100, true] });
    const named: string[] = [];
    const picked = pickPreferred([LAN, TS], probe, (c) => named.push(c.kind));
    await vi.advanceTimersByTimeAsync(100);
    await picked;
    expect(named).toEqual(['lan', 'tailnet']);
  });
});
