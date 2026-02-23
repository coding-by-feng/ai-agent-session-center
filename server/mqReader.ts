// mqReader.ts — File-based JSONL message queue reader
// Hooks append JSON lines to a queue file; this module watches it and processes events.
//
// Performance: fs.watch() for instant notification + 500ms fallback poll.
// Atomicity: POSIX guarantees atomic append for writes <= PIPE_BUF (4096 bytes).
// Our enriched hook JSON is typically 300-800 bytes.

import {
  existsSync, mkdirSync, writeFileSync,
  openSync, fstatSync, closeSync, watch,
} from 'fs';
import { open as fsOpen, stat as fsStat, writeFile as fsWriteFile } from 'fs/promises';
import type { FSWatcher, FileHandle } from 'fs';
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
let watcher: FSWatcher | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let lastByteOffset = 0;
let partialLine = '';
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let lastWatchEventAt = 0;
let lastKnownFileSize = 0;
const HEALTH_CHECK_INTERVAL_MS = 5000;

// Stats
const mqStats = {
  linesProcessed: 0,
  linesErrored: 0,
  truncations: 0,
  lastProcessedAt: null as number | null,
  startedAt: null as number | null,
};

interface MqReaderOptions {
  resumeOffset?: number;
}

/**
 * Start the MQ reader. Called once from server startup.
 * Creates queue directory/file and begins watching.
 */
export function startMqReader(options?: MqReaderOptions): void {
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

  // Initialize lastKnownFileSize so the health check doesn't false-alarm
  // on the first tick (file already has data from before the reader started).
  try {
    const initFd = openSync(QUEUE_FILE, 'r');
    lastKnownFileSize = fstatSync(initFd).size;
    closeSync(initFd);
  } catch {
    lastKnownFileSize = 0;
  }

  log.info('mq', `Queue reader started: ${QUEUE_FILE}`);

  // Do an immediate read to process any events written while the server was down
  readNewLines();

  // Start fs.watch for instant notification
  try {
    watcher = watch(QUEUE_FILE, (eventType) => {
      if (eventType === 'change') {
        lastWatchEventAt = Date.now();
        scheduleRead();
      }
    });
    watcher.on('error', (err: Error) => {
      log.warn('mq', `fs.watch error: ${err.message}, relying on poll`);
      watcher = null;
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('mq', `fs.watch failed: ${msg}, using poll only`);
  }

  // Fallback poll (catches events fs.watch may miss)
  pollTimer = setInterval(() => {
    readNewLines();
  }, POLL_INTERVAL_MS);

  // Health check: detect when fs.watch silently stops delivering events
  // If no watch events for HEALTH_CHECK_INTERVAL_MS but the file has grown, trigger a manual read
  lastWatchEventAt = Date.now();
  healthCheckTimer = setInterval(async () => {
    if (!watcher) return; // Already relying on poll only
    try {
      const fileStat = await fsStat(QUEUE_FILE);
      const currentSize = fileStat.size;
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
function scheduleRead(): void {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    readNewLines();
  }, DEBOUNCE_MS);
}

// #87: Prevent concurrent reads from overlapping
let readInProgress = false;

/**
 * Core read loop: reads from lastByteOffset to current EOF,
 * processes complete JSON lines, retains any partial trailing line.
 * #87: Uses async file I/O to avoid blocking the Node.js event loop.
 */
async function readNewLines(): Promise<void> {
  if (readInProgress) return;
  readInProgress = true;
  let fh: FileHandle | undefined;
  try {
    fh = await fsOpen(QUEUE_FILE, 'r');
    const fileStat = await fh.stat();
    const fileSize = fileStat.size;

    // File was truncated externally or is smaller than our offset
    if (fileSize < lastByteOffset) {
      log.info('mq', 'Detected external truncation, resetting offset');
      lastByteOffset = 0;
      partialLine = '';
    }

    if (fileSize <= lastByteOffset) {
      await fh.close();
      readInProgress = false;
      return;
    }

    // Read the new chunk
    const bytesToRead = fileSize - lastByteOffset;
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fh.read(buffer, 0, bytesToRead, lastByteOffset);
    await fh.close();
    fh = undefined;

    if (bytesRead === 0) { readInProgress = false; return; }

    const chunk = buffer.toString('utf-8', 0, bytesRead);
    const combined = partialLine + chunk;
    const lines = combined.split('\n');

    // Last element is either '' (if chunk ended with \n) or a partial line
    partialLine = lines.pop() || '';

    // Process each complete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const hookData = JSON.parse(trimmed);
        processHookEvent(hookData, 'mq');
        mqStats.linesProcessed++;
      } catch (err: unknown) {
        mqStats.linesErrored++;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('mq', `Parse error: ${msg} — line: ${trimmed.substring(0, 100)}`);
      }
    }

    // Update offset: advance by bytes consumed (exclude held-back partial)
    const partialBytes = Buffer.byteLength(partialLine, 'utf-8');
    lastByteOffset = lastByteOffset + bytesRead - partialBytes;
    mqStats.lastProcessedAt = Date.now();

    // Truncate if file grew too large and we've fully caught up
    if (lastByteOffset > TRUNCATE_THRESHOLD && partialLine === '') {
      await truncateQueue();
    }
  } catch (err: unknown) {
    if (fh) {
      try { await fh.close(); } catch { /* ignore */ }
    }
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      log.warn('mq', `Read error: ${e.message}`);
    } else {
      // Queue file deleted — recreate it
      try { writeFileSync(QUEUE_FILE, ''); } catch { /* ignore */ }
      lastByteOffset = 0;
      partialLine = '';
    }
  } finally {
    readInProgress = false;
  }
}

/** Truncate the queue file after all lines have been processed.
 *  Checks if file grew since our last read to avoid losing events
 *  written between the read and truncation.
 *  #87: Uses async file I/O.
 */
async function truncateQueue(): Promise<void> {
  let fh: FileHandle | undefined;
  try {
    fh = await fsOpen(QUEUE_FILE, 'r+');
    const fileStat = await fh.stat();
    // If file grew since our last read, read the new data first
    if (fileStat.size > lastByteOffset) {
      const newBytes = fileStat.size - lastByteOffset;
      const buffer = Buffer.alloc(newBytes);
      const { bytesRead } = await fh.read(buffer, 0, newBytes, lastByteOffset);
      if (bytesRead > 0) {
        const chunk = buffer.toString('utf-8', 0, bytesRead);
        const combined = partialLine + chunk;
        const lines = combined.split('\n');
        partialLine = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const hookData = JSON.parse(trimmed);
            processHookEvent(hookData, 'mq');
            mqStats.linesProcessed++;
          } catch (err: unknown) {
            mqStats.linesErrored++;
            const msg = err instanceof Error ? err.message : String(err);
            log.warn('mq', `Parse error during truncation: ${msg}`);
          }
        }
      }
    }
    // Now truncate — write remaining partial line (if any) to start of file
    await fh.close();
    fh = undefined;
    await fsWriteFile(QUEUE_FILE, partialLine);
    lastByteOffset = Buffer.byteLength(partialLine, 'utf-8');
    partialLine = '';
    mqStats.truncations++;
    log.info('mq', 'Queue file truncated (all events processed)');
  } catch (err: unknown) {
    if (fh) {
      try { await fh.close(); } catch { /* ignore */ }
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('mq', `Truncation error: ${msg}`);
  }
}

/** Stop the MQ reader. Called during server shutdown. */
export function stopMqReader(): void {
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

export interface MqStatsResult {
  linesProcessed: number;
  linesErrored: number;
  truncations: number;
  lastProcessedAt: number | null;
  startedAt: number | null;
  queueFile: string;
  running: boolean;
  currentOffset: number;
  hasPartialLine: boolean;
}

/** Get MQ reader stats for the API. */
export function getMqStats(): MqStatsResult {
  return {
    ...mqStats,
    queueFile: QUEUE_FILE,
    running,
    currentOffset: lastByteOffset,
    hasPartialLine: partialLine.length > 0,
  };
}

/** Get the current byte offset (used by snapshot persistence). */
export function getMqOffset(): number {
  return lastByteOffset;
}

/** Get the queue file path (used by install-hooks logging). */
export function getQueueFilePath(): string {
  return QUEUE_FILE;
}
