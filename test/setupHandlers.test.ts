import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs'

// Mock electron modules before importing setupHandlers
const mockHandle = vi.fn()
const mockGetPath = vi.fn().mockReturnValue('/tmp/test-user-data')
const mockGetFocusedWindow = vi.fn().mockReturnValue({
  webContents: { send: vi.fn() },
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (...args: unknown[]) => mockHandle(...args),
  },
  app: {
    getPath: (...args: unknown[]) => mockGetPath(...args),
  },
  BrowserWindow: {
    getFocusedWindow: () => mockGetFocusedWindow(),
  },
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  }
})

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('jq-1.6'),
}))

vi.mock('crypto', () => ({
  randomBytes: vi.fn().mockReturnValue({ toString: () => 'deadbeef' }),
}))

describe('setupHandlers', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown>

  beforeEach(async () => {
    handlers = {}
    mockHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers[channel] = handler
    })

    // Dynamic import to trigger handler registration
    const mod = await import('../electron/ipc/setupHandlers.js')
    mod.registerSetupHandlers()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('registers all expected IPC channels', () => {
    expect(handlers['setup:is-complete']).toBeDefined()
    expect(handlers['setup:check-deps']).toBeDefined()
    expect(handlers['setup:save-config']).toBeDefined()
    expect(handlers['setup:install-hooks']).toBeDefined()
    expect(handlers['setup:complete']).toBeDefined()
  })

  it('setup:is-complete returns false when setup.json does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const result = handlers['setup:is-complete']()
    expect(result).toBe(false)
  })

  it('setup:is-complete returns true when setup.json exists', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const result = handlers['setup:is-complete']()
    expect(result).toBe(true)
  })

  it('setup:save-config rejects invalid config object', () => {
    const result = handlers['setup:save-config']({}, null)
    expect(result).toEqual({ ok: false, error: 'Invalid config' })
  })

  it('setup:save-config rejects invalid port', () => {
    const result = handlers['setup:save-config']({}, {
      port: 99999,
      hookDensity: 'medium',
      enabledClis: ['claude'],
    })
    expect(result).toEqual({ ok: false, error: 'Invalid port' })
  })

  it('setup:save-config rejects invalid density', () => {
    const result = handlers['setup:save-config']({}, {
      port: 3333,
      hookDensity: 'extreme',
      enabledClis: ['claude'],
    })
    expect(result).toEqual({ ok: false, error: 'Invalid hook density' })
  })

  it('setup:save-config rejects invalid CLI list', () => {
    const result = handlers['setup:save-config']({}, {
      port: 3333,
      hookDensity: 'medium',
      enabledClis: ['claude', 'invalid-cli'],
    })
    expect(result).toEqual({ ok: false, error: 'Invalid CLI list' })
  })

  it('setup:save-config accepts valid config', () => {
    vi.mocked(existsSync).mockReturnValue(true)

    const result = handlers['setup:save-config']({}, {
      port: 3333,
      hookDensity: 'medium',
      enabledClis: ['claude', 'gemini'],
      debug: false,
      sessionHistoryHours: 24,
    })
    expect(result).toEqual({ ok: true })
    expect(writeFileSync).toHaveBeenCalled()
    expect(renameSync).toHaveBeenCalled()
  })

  it('setup:check-deps returns dependency results', () => {
    const result = handlers['setup:check-deps']()
    expect(result).toBeDefined()
    expect(typeof result).toBe('object')
  })
})
