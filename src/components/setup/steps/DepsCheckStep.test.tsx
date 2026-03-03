import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import DepsCheckStep from './DepsCheckStep'
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
  saveConfig: vi.fn(),
  installHooks: vi.fn(),
  completeSetup: vi.fn(),
  onInstallLog: vi.fn(),
  getPort: vi.fn(),
  openInBrowser: vi.fn(),
  rerunSetup: vi.fn(),
}

beforeEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(window, 'electronAPI', {
    value: mockAPI,
    writable: true,
    configurable: true,
  })
})

describe('DepsCheckStep', () => {
  it('shows loading spinner while checking dependencies', () => {
    // checkDeps never resolves — stays in loading state
    mockAPI.checkDeps.mockReturnValue(new Promise(() => {}))
    render(
      <DepsCheckStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    expect(screen.getByText(/checking dependencies/i)).toBeInTheDocument()
  })

  it('shows warning hint for missing jq (optional dep)', async () => {
    mockAPI.checkDeps.mockResolvedValue({
      jq: { ok: false, hint: 'Install with: brew install jq   (optional — improves session detection)' },
      curl: { ok: true },
    })
    render(
      <DepsCheckStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText(/brew install jq/)).toBeInTheDocument()
    })
  })

  it('shows Continue button when all required deps are ok', async () => {
    mockAPI.checkDeps.mockResolvedValue({
      jq: { ok: true, version: 'jq-1.7' },
      curl: { ok: true },
    })
    render(
      <DepsCheckStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument()
    })
  })

  it('shows Continue button when only optional deps are missing', async () => {
    mockAPI.checkDeps.mockResolvedValue({
      jq: { ok: false, hint: 'brew install jq' },
      curl: { ok: true },
    })
    render(
      <DepsCheckStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    // jq is optional on darwin, curl is required — so Continue should show
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument()
    })
  })

  it('shows error state when checkDeps fails', async () => {
    mockAPI.checkDeps.mockRejectedValue(new Error('Network error'))
    render(
      <DepsCheckStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText(/failed to check dependencies/i)).toBeInTheDocument()
      expect(screen.getByText(/network error/i)).toBeInTheDocument()
    })
  })

  it('renders empty deps list when electronAPI is absent (web mode)', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    render(
      <DepsCheckStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    // Without electronAPI, it immediately resolves with empty deps
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument()
    })
  })

  it('displays version when dep is ok', async () => {
    mockAPI.checkDeps.mockResolvedValue({
      jq: { ok: true, version: 'jq-1.7' },
      curl: { ok: true },
    })
    render(
      <DepsCheckStep
        config={defaultConfig}
        setConfig={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText(/v?jq-1\.7/)).toBeInTheDocument()
    })
  })
})
