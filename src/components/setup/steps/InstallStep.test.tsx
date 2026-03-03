import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import InstallStep from './InstallStep'
import type { SetupConfig } from '@/types/electron'

const defaultConfig: SetupConfig = {
  port: 3333,
  enabledClis: ['claude'],
  hookDensity: 'medium',
  debug: false,
  sessionHistoryHours: 24,
}

let logCallback: ((line: string) => void) | null = null

const mockAPI = {
  platform: 'darwin' as const,
  isSetup: vi.fn(),
  checkDeps: vi.fn(),
  saveConfig: vi.fn(),
  installHooks: vi.fn().mockResolvedValue({ ok: true }),
  completeSetup: vi.fn(),
  onInstallLog: vi.fn((cb: (line: string) => void) => {
    logCallback = cb
  }),
  getPort: vi.fn(),
  openInBrowser: vi.fn(),
  rerunSetup: vi.fn(),
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.useFakeTimers()
  logCallback = null
  mockAPI.installHooks.mockResolvedValue({ ok: true })
  mockAPI.onInstallLog.mockImplementation((cb: (line: string) => void) => {
    logCallback = cb
  })
  Object.defineProperty(window, 'electronAPI', {
    value: mockAPI,
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('InstallStep', () => {
  it('shows installing status on mount', () => {
    render(
      <InstallStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    expect(screen.getByText(/installing hooks/i)).toBeInTheDocument()
  })

  it('calls installHooks with correct config on mount', () => {
    render(
      <InstallStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    expect(mockAPI.installHooks).toHaveBeenCalledWith({
      hookDensity: 'medium',
      enabledClis: ['claude'],
    })
  })

  it('displays log lines as they arrive', async () => {
    render(
      <InstallStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )

    act(() => {
      logCallback?.('Installing Claude Code hooks...')
    })

    expect(screen.getByText(/installing claude code hooks/i)).toBeInTheDocument()
  })

  it('shows completion and calls onNext when DONE log line arrives', async () => {
    const onNext = vi.fn()
    render(
      <InstallStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={onNext}
      />,
    )

    act(() => {
      logCallback?.('Step 1: Writing hook scripts...')
      logCallback?.('DONE')
    })

    expect(screen.getByText(/installation complete/i)).toBeInTheDocument()

    // onNext called after 1500ms delay
    expect(onNext).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1500) })
    expect(onNext).toHaveBeenCalledOnce()
  })

  it('shows error state and Retry button when installHooks rejects', async () => {
    // Use real timers for this test since it relies on async rejection
    vi.useRealTimers()
    mockAPI.installHooks.mockRejectedValue(new Error('Permission denied'))
    render(
      <InstallStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/installation failed/i)).toBeInTheDocument()
      expect(screen.getByText(/permission denied/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    })
    // Restore fake timers for remaining tests
    vi.useFakeTimers()
  })

  it('skips in web mode when electronAPI is not present', () => {
    Object.defineProperty(window, 'electronAPI', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    const onNext = vi.fn()
    render(
      <InstallStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={onNext}
      />,
    )

    // In web mode, it logs a skip message and calls onNext after delay
    expect(screen.getByText(/web mode/i)).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1500) })
    expect(onNext).toHaveBeenCalledOnce()
  })
})
