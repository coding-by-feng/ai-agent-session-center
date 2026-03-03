// test/electron/setupHandlers.test.ts — Unit tests for electron/ipc/setupHandlers.ts
// Mocks Electron, child_process, and fs to test IPC handlers in isolation.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

// ── Mock fs at module level ─────────────────────────────────────────────────

const _existsSyncMock = vi.fn<(p: string) => boolean>(() => false)
const _writeFileSyncMock = vi.fn()
const _mkdirSyncMock = vi.fn()
const _renameSyncMock = vi.fn()
const _unlinkSyncMock = vi.fn()

vi.mock('fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('fs')>()
  return {
    ...orig,
    existsSync: (...args: Parameters<typeof orig.existsSync>) => _existsSyncMock(args[0] as string),
    writeFileSync: (...args: unknown[]) => _writeFileSyncMock(...args),
    mkdirSync: (...args: unknown[]) => _mkdirSyncMock(...args),
    renameSync: (...args: unknown[]) => _renameSyncMock(...args),
    unlinkSync: (...args: unknown[]) => _unlinkSyncMock(...args),
  }
})

// ── Mock child_process at module level ──────────────────────────────────────

const _execSyncMock = vi.fn()

vi.mock('child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('child_process')>()
  return {
    ...orig,
    execSync: (...args: unknown[]) => _execSyncMock(...args),
  }
})

// ── Mock Electron ───────────────────────────────────────────────────────────

const handlers: Record<string, Function> = {}

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      handlers[channel] = handler
    }),
  },
  app: {
    getPath: vi.fn(() => '/tmp/test-electron-userData'),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => ({
      webContents: { send: vi.fn() },
      setResizable: vi.fn(),
      setSize: vi.fn(),
      center: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
    })),
  },
}))

// Helper: call an IPC handler as if invoked from the renderer
const invokeHandler = (channel: string, ...args: unknown[]) =>
  handlers[channel]?.({}, ...args)

// ── Register handlers before each test ──────────────────────────────────────

beforeEach(async () => {
  // Clear registered handlers
  for (const k of Object.keys(handlers)) delete handlers[k]

  // Reset mocks
  _existsSyncMock.mockReset()
  _writeFileSyncMock.mockReset()
  _mkdirSyncMock.mockReset()
  _renameSyncMock.mockReset()
  _unlinkSyncMock.mockReset()
  _execSyncMock.mockReset()

  // Re-import and register handlers
  vi.resetModules()
  // Re-apply electron mock after module reset
  vi.doMock('electron', () => ({
    ipcMain: {
      handle: vi.fn((channel: string, handler: Function) => {
        handlers[channel] = handler
      }),
    },
    app: {
      getPath: vi.fn(() => '/tmp/test-electron-userData'),
    },
    BrowserWindow: {
      getFocusedWindow: vi.fn(() => ({
        webContents: { send: vi.fn() },
        setResizable: vi.fn(),
        setSize: vi.fn(),
        center: vi.fn(),
        loadURL: vi.fn().mockResolvedValue(undefined),
      })),
    },
  }))

  const mod = await import('../../electron/ipc/setupHandlers.js')
  mod.registerSetupHandlers()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('setup:is-complete', () => {
  it('returns false when setup.json does not exist', () => {
    _existsSyncMock.mockReturnValue(false)
    const result = invokeHandler('setup:is-complete')
    expect(result).toBe(false)
  })

  it('returns true when setup.json exists', () => {
    _existsSyncMock.mockReturnValue(true)
    const result = invokeHandler('setup:is-complete')
    expect(result).toBe(true)
  })
})

describe('setup:check-deps on macOS', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })

  it('returns jq ok=true when jq is installed', () => {
    _execSyncMock
      .mockReturnValueOnce('jq-1.7')   // jq --version
      .mockReturnValueOnce('/usr/bin/curl') // which curl
    const result = invokeHandler('setup:check-deps')
    expect(result.jq.ok).toBe(true)
    expect(result.jq.version).toBe('jq-1.7')
  })

  it('returns jq ok=false with brew hint when jq missing', () => {
    _execSyncMock
      .mockImplementationOnce(() => { throw new Error('not found') }) // jq
      .mockReturnValueOnce('/usr/bin/curl') // curl
    const result = invokeHandler('setup:check-deps')
    expect(result.jq.ok).toBe(false)
    expect(result.jq.hint).toContain('brew install jq')
  })

  it('returns curl ok=true when curl is present', () => {
    _execSyncMock
      .mockReturnValueOnce('jq-1.7') // jq
      .mockReturnValueOnce('/usr/bin/curl') // curl
    const result = invokeHandler('setup:check-deps')
    expect(result.curl.ok).toBe(true)
  })

  it('returns curl ok=false when curl is missing', () => {
    _execSyncMock
      .mockReturnValueOnce('jq-1.7') // jq
      .mockImplementationOnce(() => { throw new Error('not found') }) // curl
    const result = invokeHandler('setup:check-deps')
    expect(result.curl.ok).toBe(false)
    expect(result.curl.hint).toContain('curl not found')
  })
})

describe('setup:check-deps on Windows', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  it('returns powershell ok=true with RemoteSigned policy', () => {
    _execSyncMock.mockReturnValueOnce('RemoteSigned')
    const result = invokeHandler('setup:check-deps')
    expect(result.powershell.ok).toBe(true)
  })

  it('returns powershell ok=false with Restricted policy', () => {
    _execSyncMock.mockReturnValueOnce('Restricted')
    const result = invokeHandler('setup:check-deps')
    expect(result.powershell.ok).toBe(false)
    expect(result.powershell.hint).toContain('Set-ExecutionPolicy')
  })
})

describe('setup:save-config', () => {
  it('writes config and returns ok=true for valid input', () => {
    _existsSyncMock.mockReturnValue(true) // data dir exists
    const cfg = {
      port: 3333,
      enabledClis: ['claude'],
      hookDensity: 'medium',
      debug: false,
      sessionHistoryHours: 24,
    }
    const result = invokeHandler('setup:save-config', cfg)
    expect(result.ok).toBe(true)
    expect(_writeFileSyncMock).toHaveBeenCalledOnce()

    // Verify written JSON contains correct values
    const writtenContent = _writeFileSyncMock.mock.calls[0][1] as string
    const parsed = JSON.parse(writtenContent)
    expect(parsed.port).toBe(3333)
    expect(parsed.enabledClis).toEqual(['claude'])
    expect(parsed.hookDensity).toBe('medium')
  })

  it('creates data directory if it does not exist', () => {
    _existsSyncMock.mockReturnValue(false) // data dir missing
    const cfg = {
      port: 3333,
      enabledClis: ['claude'],
      hookDensity: 'medium',
      debug: false,
      sessionHistoryHours: 24,
    }
    invokeHandler('setup:save-config', cfg)
    expect(_mkdirSyncMock).toHaveBeenCalled()
  })

  it('rejects invalid port (out of range)', () => {
    const cfg = {
      port: 99999,
      enabledClis: ['claude'],
      hookDensity: 'medium',
      debug: false,
      sessionHistoryHours: 24,
    }
    const result = invokeHandler('setup:save-config', cfg)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/port/i)
  })

  it('rejects invalid port (negative)', () => {
    const result = invokeHandler('setup:save-config', {
      port: -1,
      enabledClis: ['claude'],
      hookDensity: 'medium',
      debug: false,
      sessionHistoryHours: 24,
    })
    expect(result.ok).toBe(false)
  })

  it('rejects non-integer port', () => {
    const result = invokeHandler('setup:save-config', {
      port: 3333.5,
      enabledClis: ['claude'],
      hookDensity: 'medium',
      debug: false,
      sessionHistoryHours: 24,
    })
    expect(result.ok).toBe(false)
  })

  it('rejects invalid hook density', () => {
    const result = invokeHandler('setup:save-config', {
      port: 3333,
      enabledClis: ['claude'],
      hookDensity: 'ultra',
      debug: false,
      sessionHistoryHours: 24,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/density/i)
  })

  it('rejects invalid CLI names', () => {
    const result = invokeHandler('setup:save-config', {
      port: 3333,
      enabledClis: ['invalid-cli'],
      hookDensity: 'medium',
      debug: false,
      sessionHistoryHours: 24,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/cli/i)
  })

  it('rejects non-object input', () => {
    const result = invokeHandler('setup:save-config', null)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid config')
  })

  it('rejects string input', () => {
    const result = invokeHandler('setup:save-config', 'bad')
    expect(result.ok).toBe(false)
  })

  it('preserves passwordHash when provided', () => {
    _existsSyncMock.mockReturnValue(true)
    const cfg = {
      port: 3333,
      enabledClis: ['claude'],
      hookDensity: 'medium',
      debug: false,
      sessionHistoryHours: 24,
      passwordHash: 'abc123hash',
    }
    invokeHandler('setup:save-config', cfg)
    const written = JSON.parse(_writeFileSyncMock.mock.calls[0][1] as string)
    expect(written.passwordHash).toBe('abc123hash')
  })
})

describe('setup:install-hooks', () => {
  it('returns ok=false for null input', async () => {
    const result = await invokeHandler('setup:install-hooks', null)
    expect(result.ok).toBe(false)
  })

  it('returns ok=false for non-object input', async () => {
    const result = await invokeHandler('setup:install-hooks', 'invalid')
    expect(result.ok).toBe(false)
  })
})
