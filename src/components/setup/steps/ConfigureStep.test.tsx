import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfigureStep from './ConfigureStep'
import type { SetupConfig } from '@/types/electron'

const defaultConfig: SetupConfig = {
  port: 3333,
  enabledClis: ['claude'],
  hookDensity: 'medium',
  debug: false,
  sessionHistoryHours: 24,
}

const mockAPI = {
  platform: 'darwin' as const,
  isSetup: vi.fn(),
  checkDeps: vi.fn(),
  saveConfig: vi.fn().mockResolvedValue({ ok: true }),
  installHooks: vi.fn(),
  completeSetup: vi.fn(),
  onInstallLog: vi.fn(),
  getPort: vi.fn(),
  openInBrowser: vi.fn(),
  rerunSetup: vi.fn(),
}

beforeEach(() => {
  vi.restoreAllMocks()
  mockAPI.saveConfig.mockResolvedValue({ ok: true })
  Object.defineProperty(window, 'electronAPI', {
    value: mockAPI,
    writable: true,
    configurable: true,
  })
})

describe('ConfigureStep', () => {
  it('renders form with default port value', () => {
    render(
      <ConfigureStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    const portInput = screen.getByDisplayValue('3333')
    expect(portInput).toBeInTheDocument()
  })

  it('renders all CLI checkboxes', () => {
    render(
      <ConfigureStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('Gemini CLI')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
  })

  it('renders all hook density options', () => {
    render(
      <ConfigureStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(screen.getByText('Medium')).toBeInTheDocument()
    expect(screen.getByText('Low')).toBeInTheDocument()
  })

  it('has a Continue submit button', () => {
    render(
      <ConfigureStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument()
  })

  it('calls onNext and setConfig when form is submitted with valid data', async () => {
    const user = userEvent.setup()
    const setConfig = vi.fn()
    const onNext = vi.fn()

    render(
      <ConfigureStep
        config={defaultConfig}
        setConfig={setConfig}
        onNext={onNext}
      />,
    )

    await user.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => {
      expect(setConfig).toHaveBeenCalled()
      expect(onNext).toHaveBeenCalled()
    })
  })

  it('does not show password fields by default', () => {
    render(
      <ConfigureStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument()
  })

  it('shows password fields when password toggle is enabled', async () => {
    const user = userEvent.setup()
    render(
      <ConfigureStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )

    // Click the password toggle label
    await user.click(screen.getByText(/require password/i))

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Password')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Confirm password')).toBeInTheDocument()
    })
  })
})
