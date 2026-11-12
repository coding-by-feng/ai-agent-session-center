import { describe, it, expect, vi } from 'vitest';
import { existsSync, statSync } from 'fs';
import { dirname } from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  parseSshTarget, remoteTokenPath, tokenReadArgs, tunnelArgs, readOwnerToken, openTunnel,
  DEFAULT_REMOTE_DATA_DIR, SshError, type SpawnLike, type ChildLike,
} from '../cli/client/ssh.js';

const TOKEN = 'ab'.repeat(32);

/** A pretend ssh child: never a real process. */
class FakeChild extends EventEmitter implements ChildLike {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    void signal;
    return true;
  });
  finish(code: number, out = '', err = ''): void {
    if (out) this.stdout.write(out);
    if (err) this.stderr.write(err);
    this.stdout.end();
    this.stderr.end();
    this.exitCode = code;
    setImmediate(() => this.emit('close', code, null));
  }
}

function fakeSpawn(onSpawn: (child: FakeChild, cmd: string, args: string[]) => void): {
  spawn: SpawnLike; calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[]; children: FakeChild[];
} {
  const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnLike = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts: opts as Record<string, unknown> });
    const child = new FakeChild();
    children.push(child);
    setImmediate(() => onSpawn(child, cmd, args));
    return child;
  };
  return { spawn, calls, children };
}

describe('parseSshTarget', () => {
  it('reads user@host and user@host:port', () => {
    expect(parseSshTarget('you@vps.example')).toEqual({ user: 'you', host: 'vps.example', port: null, destination: 'you@vps.example' });
    expect(parseSshTarget('deploy_1@10.0.0.5:2222')).toEqual({ user: 'deploy_1', host: '10.0.0.5', port: 2222, destination: 'deploy_1@10.0.0.5' });
  });

  it('refuses metacharacters, option-looking parts and bad ports', () => {
    const bad = [
      '', 'vps.example', '@vps', 'you@', 'a@b@c', '-oProxyCommand=sh@x', 'you@-oProxyCommand=sh',
      'you@host;rm -rf ~', 'you@host$(id)', 'you@host`id`', 'you@ho st', "you@host'", 'you@host\n',
      'you@host|x', 'you@host&', 'you@host:0', 'you@host:65536', 'you@host:22x', 'you@host:', 'yöu@host',
      'you@-host', 'you@host-', 'you@.host', 'you@host..x', `you@${'a'.repeat(254)}`,
    ];
    for (const raw of bad) expect(parseSshTarget(raw), raw).toBeNull();
  });
});

describe('remoteTokenPath', () => {
  it('defaults to the Linux data folder, relative to the remote home', () => {
    expect(DEFAULT_REMOTE_DATA_DIR).toBe('.config/ai-agent-session-center');
    expect(remoteTokenPath()).toBe('.config/ai-agent-session-center/owner.token');
  });

  it('accepts an absolute folder or one under ~/ (read relative to home)', () => {
    expect(remoteTokenPath('/srv/aasc')).toBe('/srv/aasc/owner.token');
    expect(remoteTokenPath('~/Library/Application Support/ai-agent-session-center/'))
      .toBe('Library/Application Support/ai-agent-session-center/owner.token');
  });

  it('refuses anything a remote shell would interpret', () => {
    for (const bad of ["x'y", 'a;b', '$HOME/x', 'a`b`', 'a\nb', 'a|b', 'a&b', 'a>b', 'a\\b', '"a"', '', '~user/x', 'a*']) {
      expect(() => remoteTokenPath(bad), bad).toThrow(SshError);
    }
  });
});

describe('ssh argv', () => {
  const t = parseSshTarget('you@vps.example:2222')!;

  it('reads the token with BatchMode, the port as its own argument, and -- before the destination', () => {
    const args = tokenReadArgs(t);
    expect(args).toEqual([
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-p', '2222', '--', 'you@vps.example',
      "cat -- '.config/ai-agent-session-center/owner.token'",
    ]);
  });

  it('leaves -p out when the target names no port', () => {
    expect(tokenReadArgs(parseSshTarget('you@vps.example')!)).not.toContain('-p');
  });

  it('forwards a private Unix socket to the server’s loopback, and fails when the forward fails', () => {
    expect(tunnelArgs(t, { socketPath: '/tmp/aasc-x/s.sock' }, 3333)).toEqual([
      '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15', '-o', 'StreamLocalBindMask=0177', '-o', 'StreamLocalBindUnlink=yes',
      '-L', '/tmp/aasc-x/s.sock:127.0.0.1:3333', '-p', '2222', '--', 'you@vps.example',
    ]);
    expect(() => tunnelArgs(t, { socketPath: 'relative/s.sock' }, 3333)).toThrow();
    expect(() => tunnelArgs(t, { socketPath: '/tmp/a:b/s.sock' }, 3333)).toThrow();
    expect(() => tunnelArgs(t, { socketPath: '/tmp/x/s.sock' }, 70000)).toThrow();
  });

  it('a TCP forward (aasc open only) binds loopback to loopback', () => {
    expect(tunnelArgs(t, { port: 41234 }, 3333)).toEqual([
      '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15', '-L', '127.0.0.1:41234:127.0.0.1:3333', '-p', '2222', '--', 'you@vps.example',
    ]);
    expect(() => tunnelArgs(t, { port: 0 }, 3333)).toThrow();
  });
});

describe('readOwnerToken', () => {
  const t = parseSshTarget('you@vps.example')!;

  it('spawns ssh with an argument array and no shell, and returns the token', async () => {
    const { spawn, calls } = fakeSpawn((child) => child.finish(0, `${TOKEN}\n`));
    await expect(readOwnerToken(t, { spawn })).resolves.toBe(TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('ssh');
    expect(calls[0].args).toEqual(tokenReadArgs(t));
    expect(calls[0].opts.shell).toBe(false);
  });

  it('reports ssh’s own error and never the output', async () => {
    const { spawn } = fakeSpawn((child) => child.finish(255, '', 'you@vps.example: Permission denied (publickey).\n'));
    const err = await readOwnerToken(t, { spawn }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SshError);
    expect((err as SshError).message).toContain('Permission denied (publickey)');
    expect((err as SshError).exitCode).toBe(5);
  });

  it('says how to turn the owner token on when the server has none (cat exits 1, no such file)', async () => {
    const { spawn } = fakeSpawn((child) => child.finish(1, '', "cat: '/home/you/.config/ai-agent-session-center/owner.token': No such file or directory\n"));
    const err = await readOwnerToken(t, { spawn }).catch((e: unknown) => e) as SshError;
    expect(err).toBeInstanceOf(SshError);
    expect(err.exitCode).toBe(5);
    expect(err.message).toMatch(/no .*owner\.token/);
    expect(err.message).toContain('AASC_OWNER_TOKEN=1');
    expect(err.message).toContain('"ownerToken": true');
    expect(err.message).toMatch(/restart/);
  });

  it('refuses output that isn’t a token, without echoing it', async () => {
    const { spawn } = fakeSpawn((child) => child.finish(0, 'secret-looking-garbage\n'));
    const err = await readOwnerToken(t, { spawn }).catch((e: unknown) => e) as SshError;
    expect(err).toBeInstanceOf(SshError);
    expect(err.message).not.toContain('secret-looking-garbage');
  });

  it('kills a hung ssh after the deadline', async () => {
    const { spawn, children } = fakeSpawn(() => { /* never answers */ });
    const err = await readOwnerToken(t, { spawn, timeoutMs: 30 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SshError);
    expect(children[0].kill).toHaveBeenCalled();
  });
});

describe('openTunnel', () => {
  const t = parseSshTarget('you@vps.example')!;
  const quiet = { onExit: () => () => {}, pollMs: 1 };

  it('forwards over a Unix socket in a fresh 0700 folder; close() kills ssh and removes the folder', async () => {
    const { spawn, calls, children } = fakeSpawn(() => { /* stays up, like ssh -N */ });
    let probes = 0;
    const tunnel = await openTunnel(t, { spawn, remotePort: 3333, probe: async () => ++probes >= 3, ...quiet });
    expect(tunnel.port).toBeUndefined();
    const sock = tunnel.socketPath!;
    expect(sock).toMatch(/\/s\.sock$/);
    expect(statSync(dirname(sock)).mode & 0o777).toBe(0o700);
    expect(calls[0].args).toEqual(tunnelArgs(t, { socketPath: sock }, 3333));
    expect(calls[0].opts.shell).toBe(false);
    tunnel.close();
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(existsSync(dirname(sock))).toBe(false);
  });

  it('TCP is only on request (aasc open)', async () => {
    const { spawn, calls } = fakeSpawn(() => {});
    const tunnel = await openTunnel(t, { spawn, remotePort: 3333, transport: 'tcp', localPort: 45678, probe: async () => true, ...quiet });
    expect(tunnel.port).toBe(45678);
    expect(tunnel.socketPath).toBeUndefined();
    expect(calls[0].args).toEqual(tunnelArgs(t, { port: 45678 }, 3333));
    tunnel.close();
  });

  it('kills the child and removes the folder when the process exits, even without close()', async () => {
    const { spawn, children } = fakeSpawn(() => {});
    let exitHook: (() => void) | null = null;
    const tunnel = await openTunnel(t, {
      spawn, remotePort: 3333, probe: async () => true, onExit: (fn) => { exitHook = fn; return () => {}; }, pollMs: 1,
    });
    exitHook!();
    expect(children[0].kill).toHaveBeenCalled();
    expect(existsSync(dirname(tunnel.socketPath!))).toBe(false);
  });

  it('close() unregisters its exit hook', async () => {
    const { spawn } = fakeSpawn(() => {});
    const unregister = vi.fn();
    const tunnel = await openTunnel(t, { spawn, remotePort: 3333, probe: async () => true, onExit: () => unregister, pollMs: 1 });
    tunnel.close();
    expect(unregister).toHaveBeenCalled();
  });

  it('fails with ssh’s message when ssh exits before the forward is up, and cleans up', async () => {
    const { spawn, calls } = fakeSpawn((child) => child.finish(255, '', 'unix_listener: cannot bind to path\n'));
    const err = await openTunnel(t, { spawn, remotePort: 3333, probe: async () => false, ...quiet }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SshError);
    expect((err as SshError).message).toContain('cannot bind to path');
    const forward = calls[0].args[calls[0].args.indexOf('-L') + 1];
    expect(existsSync(dirname(forward.split(':')[0]))).toBe(false);
  });

  it('gives up and kills ssh when the forward never comes up', async () => {
    const { spawn, children } = fakeSpawn(() => {});
    const err = await openTunnel(t, {
      spawn, remotePort: 3333, probe: async () => false, ...quiet, readyTimeoutMs: 30,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SshError);
    expect(children[0].kill).toHaveBeenCalled();
  });
});
