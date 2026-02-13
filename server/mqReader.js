// mqReader.js — File-based JSONL message queue reader
// Hooks append JSON lines to a queue file; this module watches it and processes events.
//
// Performance: fs.watch() for instant notification + 500ms fallback poll.
// Atomicity: POSIX guarantees atomic append for writes <= PIPE_BUF (4096 bytes).
// Our enriched hook JSON is typically 300-800 bytes.

import {
  existsSync, mkdirSync, writeFileSync,
  openSync, readSync, closeSync, fstatSync, watch
} from 'fs';
import { join } from 'path';
import { processHookEvent } from './hookProcessor.js';
import log from './logger.js';

// Use /tmp on macOS/Linux (matches the hardcoded path in dashboard-hook.sh).
// os.tmpdir() on macOS returns /var/folders/... which hooks can't predict.
// On Windows, hooks use $env:TEMP which matches os.tmpdir().
const QUEUE_DIR = process.platform === 'win32'
  ? join(process.env.TEMP || process.env.TMP || 'C:\\Temp', 'claude-session-center')
  : '/tmp/claude-session-center';
const QUEUE_FILE = join(QUEUE_DIR, 'queue.jsonl');
const POLL_INTERVAL_MS = 500;
const DEBOUNCE_MS = 10;
const TRUNCATE_THRESHOLD = 1 * 1024 * 1024; // 1 MB

// Internal state
let watcher = null;
let pollTimer = null;
let healthCheckTimer = null;
let lastByteOffset = 0;
let partialLine = '';
let debounceTimer = null;
let running = false;
let lastWatchEventAt = 0;
let lastKnownFileSize = 0;
const HEALTH_CHECK_INTERVAL_MS = 5000;

// Stats
const mqStats = {
  linesProcessed: 0,
  linesErrored: 0,
  truncations: 0,
  lastProcessedAt: null,
  startedAt: null,
};

/**
 * Start the MQ reader. Called once from server startup.
 * Creates queue directory/file and begins watching.
 * @param {{ resumeOffset?: number }} [options] - Optional resume offset from snapshot
 */
export function startMqReader(options) {
  if (running) return;
  running = true;
  mqStats.startedAt = Date.now();

  // Ensure queue directory exists
  mkdirSync(QUEUE_DIR, { recursive: true });

  // Create queue file if it doesn't exist (but don't truncate existing)
  if (!existsSync(QUEUE_FILE)) {
    writeFileSync(QUEUE_FILE, '');
  }

  // Resume from snapshot offset or start from current EOF
  if (options?.resumeOffset != null && options.resumeOffset >= 0) {
    // Clamp to file size in case file was truncated externally
    try {
      const fd = openSync(QUEUE_FILE, 'r');
      const stat = fstatSync(fd);
      closeSync(fd);
      lastByteOffset = Math.min(options.resumeOffset, stat.size);
    } catch {
      lastByteOffset = 0;
    }
    log.info('mq', `Resuming from offset ${lastByteOffset} (snapshot)`);
  } else {
    // No snapshot — skip existing data (already stale), start from EOF
    try {
      const fd = openSync(QUEUE_FILE, 'r');
      const stat = fstatSync(fd);
      closeSync(fd);
      lastByteOffset = stat.size;
    } catch {
      lastByteOffset = 0;
    }
  }
  partialLine = '';

  log.info('mq', `Queue reader started: ${QUEUE_FILE}`);

  // Start fs.watch for instant notification
  try {
    watcher = watch(QUEUE_FILE, (eventType) => {
      if (eventType === 'change') {
        lastWatchEventAt = Date.now();
        scheduleRead();
      }
    });
    watcher.on('error', (err) => {
      log.warn('mq', `fs.watch error: ${err.message}, relying on poll`);
      watcher = null;
    });
  } catch (err) {
    log.warn('mq', `fs.watch failed: ${err.message}, using poll only`);
  }

  // Fallback poll (catches events fs.watch may miss)
  pollTimer = setInterval(() => {
    readNewLines();
  }, POLL_INTERVAL_MS);

  // Health check: detect when fs.watch silently stops delivering events
  // If no watch events for HEALTH_CHECK_INTERVAL_MS but the file has grown, trigger a manual read
  lastWatchEventAt = Date.now();
  healthCheckTimer = setInterval(() => {
    if (!watcher) return; // Already relying on poll only
    try {
      const fd = openSync(QUEUE_FILE, 'r');
      const stat = fstatSync(fd);
      closeSync(fd);
      const currentSize = stat.size;
      const timeSinceWatch = Date.now() - lastWatchEventAt;
      if (timeSinceWatch > HEALTH_CHECK_INTERVAL_MS && currentSize > lastKnownFileSize) {
        log.warn('mq', `fs.watch stale (${Math.round(timeSinceWatch / 1000)}s silent, file grew ${currentSize - lastKnownFileSize} bytes), triggering manual read`);
        readNewLines();
      }
      lastKnownFileSize = currentSize;
    } catch {
      // File may not exist yet, ignore
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/** Debounced read scheduler — coalesces rapid fs.watch events */
function scheduleRead() {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    readNewLines();
  }, DEBOUNCE_MS);
}

/**
 * Core read loop: reads from lastByteOffset to current EOF,
 * processes complete JSON lines, retains any partial trailing line.
 */
function readNewLines() {
  let fd;
  try {
    fd = openSync(QUEUE_FILE, 'r');
    const fileStat = fstatSync(fd);
    const fileSize = fileStat.size;

    // File was truncated externally or is smaller than our offset
    if (fileSize < lastByteOffset) {
      log.info('mq', 'Detected external truncation, resetting offset');
      lastByteOffset = 0;
      partialLine = '';
    }

    if (fileSize <= lastByteOffset) {
      closeSync(fd);
      return;
    }

    // Read the new chunk
    const bytesToRead = fileSize - lastByteOffset;
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, lastByteOffset);
    closeSync(fd);
    fd = null;

    if (bytesRead === 0) return;

    const chunk = buffer.toString('utf-8', 0, bytesRead);
    const combined = partialLine + chunk;
    const lines = combined.split('\n');

    // Last element is either '' (if chunk ended with \n) or a partial line
    partialLine = lines.pop();

    // Process each complete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const hookData = JSON.parse(trimmed);
        processHookEvent(hookData, 'mq');
        mqStats.linesProcessed++;
      } catch (err) {
        mqStats.linesErrored++;
        log.warn('mq', `Parse error: ${err.message} — line: ${trimmed.substring(0, 100)}`);
      }
    }

    // Update offset: advance by bytes consumed (exclude held-back partial)
    const partialBytes = Buffer.byteLength(partialLine, 'utf-8');
    lastByteOffset = lastByteOffset + bytesRead - partialBytes;
    mqStats.lastProcessedAt = Date.now();

    // Truncate if file grew too large and we've fully caught up
    if (lastByteOffset > TRUNCATE_THRESHOLD && partialLine === '') {
      truncateQueue();
    }
  } catch (err) {
    if (fd != null) {
      try { closeSync(fd); } catch {}
    }
    if (err.code !== 'ENOENT') {
      log.warn('mq', `Read error: ${err.message}`);
    } else {
      // Queue file deleted — recreate it
      try { writeFileSync(QUEUE_FILE, ''); } catch {}
      lastByteOffset = 0;
      partialLine = '';
    }
  }
}

/** Truncate the queue file after all lines have been processed.
 *  Checks if file grew since our last read to avoid losing events
 *  written between the read and truncation.
 */
function truncateQueue() {
  let fd;
  try {
    fd = openSync(QUEUE_FILE, 'r+');
    const stat = fstatSync(fd);
    // If file grew since our last read, read the new data first
    if (stat.size > lastByteOffset) {
      const newBytes = stat.size - lastByteOffset;
      const buffer = Buffer.alloc(newBytes);
      const bytesRead = readSync(fd, buffer, 0, newBytes, lastByteOffset);
      if (bytesRead > 0) {
        const chunk = buffer.toString('utf-8', 0, bytesRead);
        const combined = partialLine + chunk;
        const lines = combined.split('\n');
        partialLine = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const hookData = JSON.parse(trimmed);
            processHookEvent(hookData, 'mq');
            mqStats.linesProcessed++;
          } catch (err) {
            mqStats.linesErrored++;
            log.warn('mq', `Parse error during truncation: ${err.message}`);
          }
        }
      }
    }
    // Now truncate — write remaining partial line (if any) to start of file
    closeSync(fd);
    fd = null;
    writeFileSync(QUEUE_FILE, partialLine);
    lastByteOffset = Buffer.byteLength(partialLine, 'utf-8');
    partialLine = '';
    mqStats.truncations++;
    log.info('mq', 'Queue file truncated (all events processed)');
  } catch (err) {
    if (fd != null) {
      try { closeSync(fd); } catch {}
    }
    log.warn('mq', `Truncation error: ${err.message}`);
  }
}

/** Stop the MQ reader. Called during server shutdown. */
export function stopMqReader() {
  running = false;
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  // Final read to flush remaining lines
  readNewLines();
  log.info('mq', `Queue reader stopped. Processed: ${mqStats.linesProcessed}, Errors: ${mqStats.linesErrored}`);
}

/** Get MQ reader stats for the API. */
export function getMqStats() {
  return {
    ...mqStats,
    queueFile: QUEUE_FILE,
    running,
    currentOffset: lastByteOffset,
    hasPartialLine: partialLine.length > 0,
  };
}

/** Get the current byte offset (used by snapshot persistence). */
export function getMqOffset() {
  return lastByteOffset;
}

/** Get the queue file path (used by install-hooks logging). */
export function getQueueFilePath() {
  return QUEUE_FILE;
}
