// test/lanAdvertiser.test.ts — the Mac's Bonjour advertisement (`_aasc._tcp`) for the phone's LAN rescan.
//
// The system responder does the work (`dns-sd -R` on macOS, `avahi-publish -s` on Linux), wrapped in a
// small sh watchdog that ends it when this process's pipe closes, so a crashed or killed server never
// leaves an advertisement behind. Only the name and port are advertised: which phones are paired is
// proven per phone by POST /api/mobile/identify, never published.
import { EventEmitter } from 'node:events';
import { spawn as realSpawn } from 'node:child_process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  advertiseCommand, AASC_SERVICE_TYPE, MAX_RESTARTS, RESTART_DELAY_MS, serviceInstanceName, shouldAdvertise,
  startLanAdvertiser, WATCHDOG_SCRIPT,
} from '../server/mobile/lanAdvertiser.js';

describe('advertiseCommand', () => {
  it('registers through dns-sd on macOS', () => {
    expect(advertiseCommand('darwin', 'Kason-MBP', 3334)).toEqual({
      cmd: 'dns-sd', args: ['-R', 'Kason-MBP', '_aasc._tcp', 'local', '3334', 'v=1'],
    });
  });

  it('registers through avahi-publish on Linux', () => {
    expect(advertiseCommand('linux', 'box', 3333)).toEqual({
      cmd: 'avahi-publish', args: ['-s', 'box', '_aasc._tcp', '3333', 'v=1'],
    });
  });

  it('does nothing elsewhere', () => {
    expect(advertiseCommand('win32', 'PC', 3333)).toBeNull();
  });

  it('names the service type the phone browses for', () => {
    expect(AASC_SERVICE_TYPE).toBe('_aasc._tcp');
  });
});

describe('serviceInstanceName', () => {
  it('keeps an ordinary name', () => {
    expect(serviceInstanceName('Kason-MBP')).toBe('Kason-MBP');
  });

  it('drops control characters', () => {
    expect(serviceInstanceName('Kason\n-MBP\u0007')).toBe('Kason -MBP');
  });

  it('fits a DNS label (63 bytes) without splitting a character', () => {
    const name = serviceInstanceName('é'.repeat(40)); // 80 bytes in UTF-8
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(63);
    expect(name).toBe('é'.repeat(31));
  });

  it('falls back to AASC when nothing is left', () => {
    expect(serviceInstanceName(' \u0001 ')).toBe('AASC');
  });
});

describe('shouldAdvertise', () => {
  it.each([
    [{ passwordEnabled: true, pairingOffered: true, activePhones: 0 }, true],
    [{ passwordEnabled: true, pairingOffered: false, activePhones: 1 }, true],
    [{ passwordEnabled: true, pairingOffered: false, activePhones: 0 }, false],
    // No password: every phone route refuses, so there is nothing to find.
    [{ passwordEnabled: false, pairingOffered: true, activePhones: 2 }, false],
  ])('%o → %s', (state, expected) => {
    expect(shouldAdvertise(state)).toBe(expected);
  });
});

class FakeChild extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  kill = vi.fn();
}

describe('startLanAdvertiser', () => {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  let children: FakeChild[];
  let spawn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    spawn = vi.fn(() => {
      const c = new FakeChild();
      children.push(c);
      return c;
    });
    Object.values(log).forEach((f) => f.mockClear());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const start = (platform: NodeJS.Platform = 'darwin') =>
    startLanAdvertiser({ name: 'Kason-MBP', port: 3334, platform, spawn: spawn as never, log });

  it('runs the advertiser under the watchdog, with no shell parsing of the name', () => {
    start();
    expect(spawn).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', WATCHDOG_SCRIPT, 'aasc-lan-advertiser', 'dns-sd', '-R', 'Kason-MBP', '_aasc._tcp', 'local', '3334', 'v=1'],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
  });

  it('starts nothing where there is no advertiser', () => {
    start('win32').stop();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('stop closes the watchdog\'s pipe, which ends the advertiser', () => {
    const adv = start();
    adv.stop();
    expect(children[0].stdin.end).toHaveBeenCalled();
    expect(children[0].kill).toHaveBeenCalled();
  });

  it('restarts an advertiser that died, after a pause', () => {
    start();
    children[0].emit('exit', 1, null);
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RESTART_DELAY_MS);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('gives up after MAX_RESTARTS, with one warning', () => {
    start();
    for (let i = 0; i <= MAX_RESTARTS; i += 1) {
      children.at(-1)!.emit('exit', 1, null);
      vi.advanceTimersByTime(RESTART_DELAY_MS);
    }
    expect(spawn).toHaveBeenCalledTimes(MAX_RESTARTS + 1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('counts again after a run that lasted, so rare deaths over weeks never use up the restarts', () => {
    start();
    for (let i = 0; i < MAX_RESTARTS; i += 1) {
      children.at(-1)!.emit('exit', 1, null);
      vi.advanceTimersByTime(RESTART_DELAY_MS);
    }
    vi.advanceTimersByTime(RESTART_DELAY_MS * 2); // this one ran a while
    children.at(-1)!.emit('exit', 1, null);
    vi.advanceTimersByTime(RESTART_DELAY_MS);
    expect(spawn).toHaveBeenCalledTimes(MAX_RESTARTS + 2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not retry when the command is missing (exit 127)', () => {
    start('linux');
    children[0].emit('exit', 127, null);
    vi.advanceTimersByTime(RESTART_DELAY_MS * 2);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not restart after stop', () => {
    const adv = start();
    adv.stop();
    children[0].emit('exit', null, 'SIGTERM');
    vi.advanceTimersByTime(RESTART_DELAY_MS);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('survives a spawn error', () => {
    start();
    expect(() => children[0].emit('error', new Error('EAGAIN'))).not.toThrow();
  });
});

// The watchdog script itself, with a stand-in for dns-sd: closing our end of the pipe must end it.
describe.runIf(process.platform !== 'win32')('WATCHDOG_SCRIPT', () => {
  it('ends the advertiser when the pipe closes', async () => {
    const child = realSpawn('/bin/sh', ['-c', WATCHDOG_SCRIPT, 'aasc-lan-advertiser', 'sleep', '30'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    await new Promise((r) => setTimeout(r, 150));
    child.stdin!.end();
    const code = await Promise.race([exited, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 5000))]);
    expect(code).not.toBe('hung');
  });

  it('exits 127 when the advertiser is not installed', async () => {
    const child = realSpawn('/bin/sh', ['-c', WATCHDOG_SCRIPT, 'aasc-lan-advertiser', 'aasc-no-such-command-xyz'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    child.stdin!.destroy();
    expect(code).toBe(127);
  });
});
