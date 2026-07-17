/**
 * Tests for terminateProcessTree / reapPtyChildren — the process-group kill
 * primitive that fixes "UI says killed but the agent process survives".
 *
 * The bug: AI CLI agents run as  PTY -> /bin/zsh -l -> claude , and `claude`
 * puts itself in its OWN process group. A single-PID SIGTERM (or node-pty's
 * SIGHUP-to-the-shell) never reaches the agent or its child tool/MCP tree, so
 * it orphans to launchd and keeps running. The primitive must signal the whole
 * process GROUP and escalate SIGTERM -> SIGKILL, verifying death.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { terminateProcessTree, reapPtyChildren } from '../server/processMonitor.js';

const spawned: ChildProcess[] = [];

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Spawn a detached process (its own process group) that traps & ignores SIGTERM. */
function spawnSigtermIgnorer(): Promise<ChildProcess> {
  // trap '' TERM HUP  => ignore both signals, then sleep. Only SIGKILL ends it.
  const child = spawn('/bin/sh', ['-c', "trap '' TERM HUP; sleep 30"], {
    detached: true, // new session/process group => group kill required
    stdio: 'ignore',
  });
  spawned.push(child);
  return new Promise((resolve) => setTimeout(() => resolve(child), 150));
}

/** Spawn a parent shell that forks a child in ITS OWN group (mimics zsh -> claude). */
function spawnParentWithGroupedChild(): Promise<{ parent: ChildProcess }> {
  const parent = spawn('/bin/sh', ['-c', 'setsid sleep 30 & sleep 30'], {
    detached: true,
    stdio: 'ignore',
  });
  spawned.push(parent);
  return new Promise((resolve) => setTimeout(() => resolve({ parent }), 150));
}

afterEach(() => {
  for (const c of spawned) {
    if (c.pid) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* noop */ } try { process.kill(c.pid, 'SIGKILL'); } catch { /* noop */ } }
  }
  spawned.length = 0;
});

describe('terminateProcessTree', () => {
  it('kills a process that ignores SIGTERM by escalating to SIGKILL', async () => {
    const child = await spawnSigtermIgnorer();
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);

    const dead = await terminateProcessTree(pid);

    expect(dead).toBe(true);
    expect(isAlive(pid)).toBe(false);
  }, 10000);

  it('reports the process dead once it is gone', async () => {
    const child = await spawnSigtermIgnorer();
    const pid = child.pid!;
    const dead = await terminateProcessTree(pid);
    expect(dead).toBe(true);
  }, 10000);

  it('returns true for an already-dead / invalid pid (nothing to kill)', async () => {
    await expect(terminateProcessTree(0)).resolves.toBe(true);
    await expect(terminateProcessTree(-1)).resolves.toBe(true);
    await expect(terminateProcessTree(999999999)).resolves.toBe(true);
  });
});

describe('reapPtyChildren', () => {
  it('kills the agent child that lives in its own process group under the shell', async () => {
    const { parent } = await spawnParentWithGroupedChild();
    const parentPid = parent.pid!;
    // Give setsid a moment; the grandchild is in its own group, unreachable by
    // signalling only the parent's group.
    await new Promise((r) => setTimeout(r, 200));

    reapPtyChildren(parentPid);
    await new Promise((r) => setTimeout(r, 500));

    // The parent's direct children must be gone.
    let survivors = '';
    try {
      const { execFileSync } = await import('child_process');
      survivors = execFileSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' }).trim();
    } catch { survivors = ''; }
    expect(survivors).toBe('');
  }, 10000);
});
