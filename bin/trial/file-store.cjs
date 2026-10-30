'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { homedir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { TrialClientError } = require('./client.cjs');
const MAX_STATE_BYTES = 16 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
function error(code = 'storage_error') {
  throw new TrialClientError(code);
}
function absent(err) {
  return err && err.code === 'ENOENT';
}
function statOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if (absent(err)) return null;
    throw err;
  }
}
function owned(stat) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}
function regular(stat) {
  return stat && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && owned(stat);
}
function same(a, b) {
  return a && b && a.dev === b.dev && a.ino === b.ino;
}

function createFileTrialStore(options = {}) {
  const filePath = path.resolve(
    options.filePath || path.join(homedir(), '.config', 'aasc', 'trial.json'),
  );
  const directory = path.dirname(filePath);
  const lockPath = `${filePath}.lock`;
  let held = null;

  function ensureDirectory() {
    // Check every ancestor rather than following an attacker-controlled .config/aasc symlink.
    let current = path.parse(directory).root;
    for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat = statOrNull(current);
      if (!stat) {
        try {
          fs.mkdirSync(current, { mode: 0o700 });
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
        stat = fs.lstatSync(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) error();
    }
    const stat = fs.lstatSync(directory);
    if (!owned(stat)) error();
    if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(directory, 0o700);
  }
  function readPrivate(file, limit) {
    const before = statOrNull(file);
    if (!before) return null;
    if (!regular(before)) error();
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!regular(stat) || !same(before, stat) || stat.size > limit || (stat.mode & 0o077) !== 0)
        error();
      const bytes = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > limit || !same(stat, fs.lstatSync(file))) error();
      return { value: JSON.parse(bytes.subarray(0, length).toString('utf8')), stat };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  function ensureHeld() {
    ensureDirectory();
    if (
      !held ||
      !same(held.stat, statOrNull(lockPath)) ||
      !same(held.ownerStat, statOrNull(held.ownerPath))
    )
      error('client_locked');
    const names = fs.readdirSync(lockPath);
    if (names.length !== 1 || names[0] !== path.basename(held.ownerPath)) error('client_locked');
  }
  function syncDirectory() {
    // POSIX directory fsync makes the rename durable. Windows does not expose it consistently.
    if (process.platform === 'win32') return;
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  function acquireLock() {
    try {
      ensureDirectory();
      if (held) error('client_locked');
      for (let attempt = 0; attempt < 4; attempt++) {
        let created = false;
        try {
          fs.mkdirSync(lockPath, { mode: 0o700 });
          created = true;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
        if (created) {
          const stat = fs.lstatSync(lockPath);
          const ownerPath = path.join(lockPath, `${process.pid}-${randomUUID()}.json`);
          let fd;
          try {
            fd = fs.openSync(
              ownerPath,
              fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
              0o600,
            );
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
            fs.fsyncSync(fd);
            held = { fd, stat, ownerPath, ownerStat: fs.fstatSync(fd) };
            ensureHeld();
          } catch (err) {
            held = null;
            if (fd !== undefined) fs.closeSync(fd);
            // A concurrent stale-lock cleanup can remove an empty directory;
            // never claim a replacement directory or remove its owner's marker.
            if (same(stat, statOrNull(lockPath))) {
              try {
                fs.unlinkSync(ownerPath);
              } catch {}
              try {
                fs.rmdirSync(lockPath);
              } catch {}
            }
            throw err;
          }
          const identity = held;
          return () => {
            if (held !== identity) return;
            held = null;
            try {
              if (
                same(identity.stat, statOrNull(lockPath)) &&
                same(identity.ownerStat, statOrNull(identity.ownerPath))
              ) {
                fs.unlinkSync(identity.ownerPath);
                fs.rmdirSync(lockPath);
              }
            } catch {
              error();
            } finally {
              fs.closeSync(identity.fd);
            }
          };
        }
        const lockStat = fs.lstatSync(lockPath);
        if (
          !lockStat.isDirectory() ||
          lockStat.isSymbolicLink() ||
          !owned(lockStat) ||
          (lockStat.mode & 0o077) !== 0
        )
          error();
        const names = fs.readdirSync(lockPath);
        if (names.length === 0) {
          // Only recover abandoned setup, never a newly created lock directory.
          if (Date.now() - lockStat.mtimeMs < 60000) error('client_locked');
          try {
            fs.rmdirSync(lockPath);
          } catch (err) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err;
          }
          continue;
        }
        if (names.length !== 1 || !/^\d+-[a-f0-9-]+\.json$/.test(names[0])) error('client_locked');
        const ownerPath = path.join(lockPath, names[0]);
        const previous = readPrivate(ownerPath, 1024);
        if (!previous) continue;
        const pid = previous.value?.pid;
        if (!Number.isSafeInteger(pid) || pid <= 0) error('client_locked');
        let dead = false;
        try {
          process.kill(pid, 0);
        } catch (probe) {
          if (probe.code === 'ESRCH') dead = true;
        }
        if (!dead) error('client_locked');
        if (!same(lockStat, statOrNull(lockPath)) || !same(previous.stat, statOrNull(ownerPath)))
          continue;
        // Delete only the dead owner's unique marker. rmdir is atomic and fails
        // if any replacement owner has appeared, so reclaimers cannot steal it.
        try {
          fs.unlinkSync(ownerPath);
        } catch (err) {
          if (!absent(err)) throw err;
        }
        try {
          fs.rmdirSync(lockPath);
        } catch (err) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err;
        }
      }
      error('client_locked');
    } catch (err) {
      if (err instanceof TrialClientError) throw err;
      error();
    }
  }
  function load() {
    try {
      ensureHeld();
      return readPrivate(filePath, MAX_STATE_BYTES)?.value ?? null;
    } catch (err) {
      if (err instanceof TrialClientError) throw err;
      error();
    }
  }
  function save(state) {
    let temporary = null;
    try {
      ensureHeld();
      const existing = statOrNull(filePath);
      if (existing && !regular(existing)) error();
      if (state === null) {
        if (existing) fs.unlinkSync(filePath);
        syncDirectory();
        return;
      }
      // No transcript/code/provider settings belong in the credential file.
      if (
        state?.version !== 1 ||
        !(state.cookie === null || typeof state.cookie === 'string') ||
        !(
          state.pending === null ||
          (typeof state.pending?.requestKey === 'string' &&
            typeof state.pending?.prompt === 'string')
        )
      )
        error();
      const value = {
        version: 1,
        cookie: state.cookie,
        pending: state.pending
          ? { requestKey: state.pending.requestKey, prompt: state.pending.prompt }
          : null,
      };
      const content = JSON.stringify(value);
      if (Buffer.byteLength(content) > MAX_STATE_BYTES) error();
      temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
      const fd = fs.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
        0o600,
      );
      try {
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      ensureHeld();
      if (existing ? !same(existing, statOrNull(filePath)) : statOrNull(filePath)) error();
      fs.renameSync(temporary, filePath);
      temporary = null;
      syncDirectory();
    } catch (err) {
      if (err instanceof TrialClientError) throw err;
      error();
    } finally {
      if (temporary) {
        try {
          fs.unlinkSync(temporary);
        } catch {}
      }
    }
  }
  try {
    ensureDirectory();
  } catch {
    error();
  }
  return { load, save, acquireLock };
}
module.exports = { createFileTrialStore };
