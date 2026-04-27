/**
 * ptyHost.ts — VS Code-style PTY host for Electron.
 *
 * Manages local terminal processes directly via node-pty in the Electron
 * main process.  Terminal I/O is relayed to the renderer through IPC
 * (not WebSocket), following the same architecture VS Code uses for its
 * integrated terminal.
 *
 * In production the Express server runs in-process, so after creating a
 * PTY we also register the session with the server via HTTP so that the
 * hook pipeline, session store, and WebSocket broadcast all stay in sync.
 */

import pty from 'node-pty'
import type { IPty, IDisposable } from 'node-pty'
import { homedir } from 'os'
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PtyCreateConfig {
  workingDir?: string
  command?: string
  label?: string
  sessionTitle?: string
  apiKey?: string
  enableOpsTerminal?: boolean
  /** Effort level to auto-apply after Claude Code starts (min/low/medium/high/max) */
  effortLevel?: string
  /** Model to auto-apply after Claude Code starts (opus/sonnet/haiku) */
  model?: string
}

interface PtyInstance {
  id: string
  process: IPty
  config: PtyCreateConfig
  /** Pre-allocated ring buffer — see ringWrite() / ringSnapshot(). */
  ring: Buffer
  /** Next write offset within `ring`. */
  ringOffset: number
  /** True once the ring has been wrapped at least once (buffer is full). */
  ringWrapped: boolean
  disposables: IDisposable[]
  shellReady: Promise<boolean>
  /** Renderer WebContents currently viewing this PTY. Output is sent only to these. */
  subscribers: Set<WebContents>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTPUT_BUFFER_MAX = 128 * 1024  // 128 KB ring buffer per terminal

// ANSI escape sequences (CSI + OSC) for stripping from PTY output
const ANSI_ESC_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g

// Common shell prompt endings
const SHELL_PROMPT_RE = /[#$%>]\s*$/

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const terminals = new Map<string, PtyInstance>()

// ---------------------------------------------------------------------------
// Ring-buffer helpers — pre-allocated slab + write offset, no per-chunk concat
// ---------------------------------------------------------------------------

function ringWrite(inst: PtyInstance, chunk: Buffer): void {
  const cap = inst.ring.length
  if (chunk.length >= cap) {
    // Single chunk is larger than the ring — keep only the tail.
    chunk.copy(inst.ring, 0, chunk.length - cap)
    inst.ringOffset = 0
    inst.ringWrapped = true
    return
  }
  const tail = cap - inst.ringOffset
  if (chunk.length <= tail) {
    chunk.copy(inst.ring, inst.ringOffset)
    inst.ringOffset += chunk.length
    if (inst.ringOffset === cap) {
      inst.ringOffset = 0
      inst.ringWrapped = true
    }
  } else {
    chunk.copy(inst.ring, inst.ringOffset, 0, tail)
    chunk.copy(inst.ring, 0, tail)
    inst.ringOffset = chunk.length - tail
    inst.ringWrapped = true
  }
}

/** Linearize the ring into a contiguous Buffer (oldest → newest). */
function ringSnapshot(inst: PtyInstance): Buffer {
  if (!inst.ringWrapped) {
    return inst.ring.slice(0, inst.ringOffset)
  }
  return Buffer.concat([
    inst.ring.slice(inst.ringOffset),
    inst.ring.slice(0, inst.ringOffset),
  ])
}

function ringLength(inst: PtyInstance): number {
  return inst.ringWrapped ? inst.ring.length : inst.ringOffset
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveWorkDir(dir: string | undefined): string {
  if (!dir || dir === '~') return homedir()
  return dir.replace(/^~/, homedir())
}

function getDefaultShell(): string {
  return process.env.SHELL || '/bin/bash'
}

/** Send to every renderer window — use only for low-frequency / broadcast events. */
function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

/** Send to only the WebContents currently subscribed to this PTY. */
function sendToSubscribers(inst: PtyInstance, channel: string, ...args: unknown[]): void {
  if (inst.subscribers.size === 0) return
  for (const wc of inst.subscribers) {
    if (!wc.isDestroyed()) {
      wc.send(channel, ...args)
    }
  }
}

/**
 * Watch PTY output to detect when the shell is ready (prompt visible).
 * Resolves `true` when a prompt is detected, `false` on timeout.
 */
function detectShellReady(
  ptyProcess: IPty,
  terminalId: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let buffer = ''
    let done = false
    let settleTimer: ReturnType<typeof setTimeout> | null = null

    function finish(detected: boolean): void {
      if (done) return
      done = true
      clearTimeout(fallbackTimer)
      if (settleTimer) clearTimeout(settleTimer)
      dataDisp.dispose()
      exitDisp.dispose()
      resolve(detected)
    }

    function checkPrompt(): void {
      const stripped = buffer.replace(ANSI_ESC_RE, '')
      const lines = stripped.split(/[\r\n]+/)
      let lastLine = ''
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim()) { lastLine = lines[i].trim(); break }
      }
      if (lastLine && lastLine.length < 200 && SHELL_PROMPT_RE.test(lastLine)) {
        finish(true)
      }
    }

    const dataDisp: IDisposable = ptyProcess.onData((data: string) => {
      if (done) return
      buffer += data
      if (buffer.length > 4096) buffer = buffer.slice(-4096)
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(checkPrompt, 50)
    })

    const exitDisp: IDisposable = ptyProcess.onExit(() => { finish(false) })
    const fallbackTimer = setTimeout(() => { finish(false) }, timeoutMs)
    void terminalId // reserved for future tracing
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a local PTY terminal.  Returns the terminal ID.
 *
 * After spawning the PTY, registers the terminal with the Express server
 * so that the session store, hook pipeline, and dashboard UI all see it.
 */
// Auto-generate session name: projectName #N
const ptyProjectCounters = new Map<string, number>()
function autoSessionName(workDir: string): string {
  const projectName = workDir === homedir()
    ? 'Home'
    : workDir.split('/').filter(Boolean).pop() || 'Session'
  const counter = (ptyProjectCounters.get(projectName) || 0) + 1
  ptyProjectCounters.set(projectName, counter)
  return `${projectName} #${counter}`
}

/** Append -n "title" to claude commands for session naming */
function appendSessionName(cmd: string, title?: string | null): string {
  if (!title) return cmd
  if (!cmd.startsWith('claude')) return cmd
  if (/ -n[ =]/.test(cmd) || / --name[ =]/.test(cmd)) return cmd
  const escaped = title.replace(/"/g, '\\"')
  return `${cmd} -n "${escaped}"`
}

export function createPty(config: PtyCreateConfig): string {
  const terminalId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const workDir = resolveWorkDir(config.workingDir)
  const sessionName = config.sessionTitle || autoSessionName(workDir)
  const command = appendSessionName(config.command || 'claude', sessionName)
  const shell = getDefaultShell()

  // Build env — strip CLAUDECODE to prevent nested-session detection
  const { CLAUDECODE: _drop, ...parentEnv } = process.env as Record<string, string>
  const env: Record<string, string> = {
    ...parentEnv,
    AGENT_MANAGER_TERMINAL_ID: terminalId,
  }

  // Inject API key
  if (config.apiKey) {
    const envVar = command.startsWith('codex') ? 'OPENAI_API_KEY'
      : command.startsWith('gemini') ? 'GEMINI_API_KEY'
      : 'ANTHROPIC_API_KEY'
    env[envVar] = config.apiKey
  }

  const ptyProcess: IPty = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: workDir,
    env,
  })

  const shellReady = detectShellReady(ptyProcess, terminalId, 2000)

  const instance: PtyInstance = {
    id: terminalId,
    process: ptyProcess,
    config,
    ring: Buffer.alloc(OUTPUT_BUFFER_MAX),
    ringOffset: 0,
    ringWrapped: false,
    disposables: [],
    shellReady,
    subscribers: new Set<WebContents>(),
  }

  // Stream PTY output to subscribed renderers via IPC.
  // Unsubscribed terminals still fill the ring buffer (for replay on subscribe),
  // but do NOT send IPC messages — this eliminates the main-thread work of
  // decoding/routing output from background sessions.
  const dataDisp = ptyProcess.onData((data: string) => {
    const chunk = Buffer.from(data, 'utf8')
    ringWrite(instance, chunk)
    if (instance.subscribers.size > 0) {
      const base64 = chunk.toString('base64')
      sendToSubscribers(instance, 'pty:data', terminalId, base64)
    }
  })

  const exitDisp = ptyProcess.onExit(({ exitCode, signal }) => {
    // pty:exit is rare — broadcast to all windows so any view can clean up.
    sendToAllWindows('pty:exit', terminalId, exitCode, signal ?? 0)
    cleanup(terminalId)
  })

  instance.disposables.push(dataDisp, exitDisp)
  terminals.set(terminalId, instance)

  // Auto-type the launch command once the shell is ready
  shellReady.then((detected) => {
    const inst = terminals.get(terminalId)
    if (!inst) return
    if (!detected) {
      // Send command anyway as a fallback
    }
    inst.process.write(command + '\r')

    // Auto-apply model and/or effort level after Claude Code starts
    const baseCommand = config.command || 'claude'
    if ((config.model || config.effortLevel) && baseCommand.startsWith('claude')) {
      let autoBuffer = ''
      let autoSent = false
      const autoDisp = ptyProcess.onData((data: string) => {
        if (autoSent) return
        autoBuffer += data
        if (autoBuffer.length > 16384) autoBuffer = autoBuffer.slice(-16384)
        const stripped = autoBuffer.replace(ANSI_ESC_RE, '')
        if (stripped.includes('Claude Code')) {
          autoSent = true
          autoDisp.dispose()
          // Wait for Claude Code prompt to be fully ready
          setTimeout(() => {
            const t = terminals.get(terminalId)
            if (!t) return
            const cmds: string[] = []
            if (config.model) cmds.push(`/model ${config.model}`)
            if (config.effortLevel) cmds.push(`/effort ${config.effortLevel}`)
            cmds.forEach((cmd, i) => {
              setTimeout(() => {
                const t2 = terminals.get(terminalId)
                if (t2) t2.process.write(cmd + '\r')
              }, i * 800)
            })
          }, 2500)
        }
      })
      // Safety: stop watching after 30s
      setTimeout(() => {
        if (!autoSent) autoDisp.dispose()
      }, 30000)
    }
  })

  // Register with Express server for session store integration
  registerWithServer(terminalId, config, workDir).catch(() => {
    // Best effort — hooks will create the session anyway
  })

  return terminalId
}

/**
 * Strip terminal response sequences that should never reach PTY stdin.
 * Focus events (\x1b[I / \x1b[O) and Device Attributes responses
 * (\x1b[?...c / \x1b[>...c) are emitted by xterm.js but are not user input.
 */
const TERMINAL_RESPONSE_RE = /\x1b\[I|\x1b\[O|\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c/g

/** Write data to a PTY's stdin. */
export function writePty(terminalId: string, data: string): void {
  const inst = terminals.get(terminalId)
  if (!inst) return
  const cleaned = data.replace(TERMINAL_RESPONSE_RE, '')
  if (cleaned) inst.process.write(cleaned)
}

/** Resize a PTY. */
export function resizePty(terminalId: string, cols: number, rows: number): void {
  const inst = terminals.get(terminalId)
  if (inst) {
    try { inst.process.resize(cols, rows) } catch { /* process may be dead */ }
  }
}

/** Kill a PTY. */
export function killPty(terminalId: string): void {
  const inst = terminals.get(terminalId)
  if (inst) {
    try { inst.process.kill() } catch { /* already dead */ }
    cleanup(terminalId)
  }
}

/** Register a renderer WebContents as subscribed to this PTY. */
export function subscribePty(terminalId: string, wc: WebContents): boolean {
  const inst = terminals.get(terminalId)
  if (!inst) return false
  inst.subscribers.add(wc)
  return true
}

/** Remove a renderer WebContents from this PTY's subscribers. */
export function unsubscribePty(terminalId: string, wc: WebContents): void {
  const inst = terminals.get(terminalId)
  if (!inst) return
  inst.subscribers.delete(wc)
}

/** Remove a WebContents from every PTY's subscriber set (on window close/crash). */
export function removeSubscriberFromAll(wc: WebContents): void {
  for (const inst of terminals.values()) {
    inst.subscribers.delete(wc)
  }
}

/** Get the output buffer for replay on subscribe. */
export function getOutputBuffer(terminalId: string): string | null {
  const inst = terminals.get(terminalId)
  if (!inst || ringLength(inst) === 0) return null
  return ringSnapshot(inst).toString('base64')
}

/** Check if a terminal ID is managed by ptyHost. */
export function hasPty(terminalId: string): boolean {
  return terminals.has(terminalId)
}

/** List all active PTY terminal IDs. */
export function listPtys(): string[] {
  return Array.from(terminals.keys())
}

/** Dispose all PTYs (called on app quit). */
export function disposeAll(): void {
  for (const [id] of terminals) {
    killPty(id)
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function cleanup(terminalId: string): void {
  const inst = terminals.get(terminalId)
  if (inst) {
    for (const d of inst.disposables) {
      try { d.dispose() } catch { /* already disposed */ }
    }
    inst.subscribers.clear()
    terminals.delete(terminalId)
  }
}

/**
 * Register the terminal with the Express server so the session store
 * knows about it.  Uses the /api/terminals/register endpoint.
 */
async function registerWithServer(
  terminalId: string,
  config: PtyCreateConfig,
  workDir: string,
): Promise<void> {
  const port = process.env.SERVER_PORT || '3333'
  const body = {
    terminalId,
    host: 'localhost',
    workingDir: workDir,
    command: config.command || 'claude',
    label: config.label,
    sessionTitle: config.sessionTitle,
    source: 'electron-pty',
  }

  const res = await fetch(`http://localhost:${port}/api/terminals/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Server registration failed (${res.status}): ${text}`)
  }
}
