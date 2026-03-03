import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import DepsCheckStep from '../steps/DepsCheckStep'
import InstallStep from '../steps/InstallStep'
import DoneStep from '../steps/DoneStep'
import WelcomeStep from '../steps/WelcomeStep'
import type { StepProps } from '../SetupWizard'
import type { SetupConfig } from '@/types/electron'

const defaultConfig: SetupConfig = {
  port: 3333,
  enabledClis: ['claude'],
  hookDensity: 'medium',
  debug: false,
  sessionHistoryHours: 24,
}

function makeStepProps(overrides?: Partial<StepProps>): StepProps {
  return {
    config: defaultConfig,
    setConfig: vi.fn(),
    onNext: vi.fn(),
    ...overrides,
  }
}

describe('WelcomeStep', () => {
  it('renders the title and get started button', () => {
    const props = makeStepProps()
    render(<WelcomeStep {...props} />)
    expect(screen.getByText('AI Agent Session Center')).toBeInTheDocument()
    expect(screen.getByText('Get Started')).toBeInTheDocument()
  })

  it('calls onNext when Get Started is clicked', () => {
    const props = makeStepProps()
    render(<WelcomeStep {...props} />)
    fireEvent.click(screen.getByText('Get Started'))
    expect(props.onNext).toHaveBeenCalledOnce()
  })
})

describe('DepsCheckStep', () => {
  beforeEach(() => {
    // Reset electronAPI mock
    window.electronAPI = undefined
  })

  afterEach(() => {
    window.electronAPI = undefined
  })

  it('renders continue button in web mode (no electronAPI)', async () => {
    const props = makeStepProps()
    render(<DepsCheckStep {...props} />)

    // In web mode, it should quickly resolve and show continue
    await waitFor(() => {
      expect(screen.getByText('Continue')).toBeInTheDocument()
    })
  })

  it('shows loading spinner initially when electronAPI exists', () => {
    window.electronAPI = {
      platform: 'darwin',
      isSetup: vi.fn(),
      checkDeps: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
      saveConfig: vi.fn(),
      installHooks: vi.fn(),
      completeSetup: vi.fn(),
      onInstallLog: vi.fn(),
      getPort: vi.fn(),
      openInBrowser: vi.fn(),
      rerunSetup: vi.fn(),
    }

    const props = makeStepProps()
    render(<DepsCheckStep {...props} />)
    expect(screen.getByText('Checking dependencies...')).toBeInTheDocument()
  })

  it('shows dep results after checkDeps resolves', async () => {
    window.electronAPI = {
      platform: 'darwin',
      isSetup: vi.fn(),
      checkDeps: vi.fn().mockResolvedValue({
        jq: { ok: true, version: 'jq-1.6' },
        curl: { ok: true },
      }),
      saveConfig: vi.fn(),
      installHooks: vi.fn(),
      completeSetup: vi.fn(),
      onInstallLog: vi.fn(),
      getPort: vi.fn(),
      openInBrowser: vi.fn(),
      rerunSetup: vi.fn(),
    }

    const props = makeStepProps()
    render(<DepsCheckStep {...props} />)

    await waitFor(() => {
      expect(screen.getByText('jq')).toBeInTheDocument()
      expect(screen.getByText('curl')).toBeInTheDocument()
      expect(screen.getByText('Continue')).toBeInTheDocument()
    })
  })
})

describe('InstallStep', () => {
  beforeEach(() => {
    window.electronAPI = undefined
  })

  afterEach(() => {
    window.electronAPI = undefined
  })

  it('shows skip message in web mode', async () => {
    const props = makeStepProps()
    render(<InstallStep {...props} />)

    await waitFor(() => {
      expect(screen.getByText(/web mode/i)).toBeInTheDocument()
    })
  })

  it('calls installHooks when electronAPI is present', async () => {
    const mockInstallHooks = vi.fn().mockResolvedValue({ ok: true })
    window.electronAPI = {
      platform: 'darwin',
      isSetup: vi.fn(),
      checkDeps: vi.fn(),
      saveConfig: vi.fn(),
      installHooks: mockInstallHooks,
      completeSetup: vi.fn(),
      onInstallLog: vi.fn(),
      getPort: vi.fn(),
      openInBrowser: vi.fn(),
      rerunSetup: vi.fn(),
    }

    const props = makeStepProps()
    render(<InstallStep {...props} />)

    await waitFor(() => {
      expect(mockInstallHooks).toHaveBeenCalledWith({
        hookDensity: 'medium',
        enabledClis: ['claude'],
      })
    })
  })
})

describe('DoneStep', () => {
  beforeEach(() => {
    window.electronAPI = undefined
  })

  afterEach(() => {
    window.electronAPI = undefined
  })

  it('renders summary with config values', () => {
    const props = makeStepProps()
    render(<DoneStep {...props} />)

    expect(screen.getByText('3333')).toBeInTheDocument()
    expect(screen.getByText('claude')).toBeInTheDocument()
    expect(screen.getByText('medium')).toBeInTheDocument()
  })

  it('shows launch button', () => {
    const props = makeStepProps()
    render(<DoneStep {...props} />)
    expect(screen.getByText('Launch Dashboard')).toBeInTheDocument()
  })
})
