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

/** Satisfies every rule in ConfigureStep's passwordSchema. */
const VALID_PW = 'Str0ng!Pass'

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

    await user.type(screen.getByPlaceholderText('Password'), VALID_PW)
    await user.type(screen.getByPlaceholderText('Confirm password'), VALID_PW)
    await user.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => {
      expect(setConfig).toHaveBeenCalled()
      expect(onNext).toHaveBeenCalled()
    })
  })

  it('shows the password fields immediately — there is no opt-out toggle', () => {
    render(
      <ConfigureStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Confirm password')).toBeInTheDocument()
    expect(screen.queryByText(/require password/i)).not.toBeInTheDocument()
  })

  it('blocks Continue when no password is entered', async () => {
    const user = userEvent.setup()
    const setConfig = vi.fn()
    const onNext = vi.fn()

    render(
      <ConfigureStep config={defaultConfig} setConfig={setConfig} onNext={onNext} />,
    )

    await user.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => {
      expect(screen.getByText(/min 8 characters/i)).toBeInTheDocument()
    })
    expect(onNext).not.toHaveBeenCalled()
    expect(setConfig).not.toHaveBeenCalled()
  })

  it('blocks Continue when the confirmation does not match', async () => {
    const user = userEvent.setup()
    const onNext = vi.fn()

    render(
      <ConfigureStep config={defaultConfig} setConfig={vi.fn()} onNext={onNext} />,
    )

    await user.type(screen.getByPlaceholderText('Password'), VALID_PW)
    await user.type(screen.getByPlaceholderText('Confirm password'), `${VALID_PW}x`)
    await user.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => {
      expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument()
    })
    expect(onNext).not.toHaveBeenCalled()
  })

  // The bug this guards: the password used to be collected and validated and
  // then dropped — onSubmit built the config without it, so every install
  // finished with no password however carefully it was typed. Asserting the
  // IPC payload is the only place that regression is visible.
  it('sends the plaintext password to saveConfig for main-process hashing', async () => {
    const user = userEvent.setup()

    render(
      <ConfigureStep config={defaultConfig} setConfig={vi.fn()} onNext={vi.fn()} />,
    )

    await user.type(screen.getByPlaceholderText('Password'), VALID_PW)
    await user.type(screen.getByPlaceholderText('Confirm password'), VALID_PW)
    await user.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => {
      expect(mockAPI.saveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ password: VALID_PW }),
      )
    })
  })

  it('never puts the plaintext password into the wizard config state', async () => {
    const user = userEvent.setup()
    const setConfig = vi.fn()

    render(
      <ConfigureStep config={defaultConfig} setConfig={setConfig} onNext={vi.fn()} />,
    )

    await user.type(screen.getByPlaceholderText('Password'), VALID_PW)
    await user.type(screen.getByPlaceholderText('Confirm password'), VALID_PW)
    await user.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => expect(setConfig).toHaveBeenCalled())
    const cfg = setConfig.mock.calls[0][0]
    expect(cfg).not.toHaveProperty('password')
    expect(cfg).not.toHaveProperty('passwordHash')
  })
})
