// src/__tests__/firstRunFlow.test.tsx — Integration test: full first-run experience
// Simulates: App loads -> wizard shown (first run) or dashboard (already set up)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import type { ElectronAPI } from '@/types/electron'

// ── Mock global fetch used by useAuth, useWebSocket, etc. ────────────────
const mockFetch = vi.fn().mockImplementation((url: string) => {
  // Auth status endpoint — no password required (open mode)
  if (typeof url === 'string' && url.includes('/api/auth/status')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ requiresAuth: false }),
    })
  }
  // Default: return empty success
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  })
})

// ── Mock WebSocket to prevent real connections ────────────────────────────
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}))

// ── Mock useSettingsInit to avoid side effects ───────────────────────────
vi.mock('@/hooks/useSettingsInit', () => ({
  useSettingsInit: vi.fn(),
}))

// ── Mock react-three/fiber and drei to avoid WebGL errors ────────────────
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useFrame: vi.fn(),
  useThree: vi.fn(() => ({
    camera: { position: { set: vi.fn() } },
    gl: { domElement: document.createElement('canvas') },
  })),
}))

vi.mock('@react-three/drei', () => ({
  OrbitControls: () => null,
  PerspectiveCamera: () => null,
  Environment: () => null,
  useHelper: vi.fn(),
}))

// ── Setup ────────────────────────────────────────────────────────────────

const createMockAPI = (overrides: Partial<ElectronAPI> = {}): ElectronAPI => ({
  platform: 'darwin',
  isSetup: vi.fn().mockResolvedValue(false),
  checkDeps: vi.fn().mockResolvedValue({ jq: { ok: true }, curl: { ok: true } }),
  saveConfig: vi.fn().mockResolvedValue({ ok: true }),
  installHooks: vi.fn().mockResolvedValue({ ok: true }),
  completeSetup: vi.fn().mockResolvedValue({ ok: true, port: 3333 }),
  onInstallLog: vi.fn(),
  getPort: vi.fn().mockResolvedValue(3333),
  openInBrowser: vi.fn(),
  rerunSetup: vi.fn(),
  ...overrides,
})

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'electronAPI', {
    value: undefined,
    writable: true,
    configurable: true,
  })
})

describe('First-Run Flow Integration', () => {
  it('shows setup wizard on first run (isSetup returns false)', async () => {
    const api = createMockAPI({ isSetup: vi.fn().mockResolvedValue(false) })
    Object.defineProperty(window, 'electronAPI', {
      value: api,
      writable: true,
      configurable: true,
    })

    // Dynamic import to ensure mocks are in place
    const { default: App } = await import('@/App')
    render(<App />)

    // First, should show loading state
    // Then resolve to wizard
    await waitFor(() => {
      // The SetupWizard renders the WelcomeStep with "Get Started" button
      expect(screen.getByText(/get started/i)).toBeInTheDocument()
    })

    expect(api.isSetup).toHaveBeenCalledOnce()
  })

  it('shows loading state before isSetup resolves', async () => {
    // isSetup never resolves — stays in loading
    const api = createMockAPI({
      isSetup: vi.fn().mockReturnValue(new Promise(() => {})),
    })
    Object.defineProperty(window, 'electronAPI', {
      value: api,
      writable: true,
      configurable: true,
    })

    const { default: App } = await import('@/App')
    render(<App />)

    // Should show loading splash
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
    // Should NOT show the wizard content
    expect(screen.queryByText(/get started/i)).not.toBeInTheDocument()
  })

  it('skips wizard when electronAPI is not present (web mode)', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: undefined,
      writable: true,
      configurable: true,
    })

    const { default: App } = await import('@/App')
    render(<App />)

    // In web mode, App skips wizard and goes directly to auth gate
    await waitFor(() => {
      // Should NOT show setup wizard
      expect(screen.queryByText(/get started/i)).not.toBeInTheDocument()
    })
  })

  it('skips wizard when setup is already complete', async () => {
    const api = createMockAPI({ isSetup: vi.fn().mockResolvedValue(true) })
    Object.defineProperty(window, 'electronAPI', {
      value: api,
      writable: true,
      configurable: true,
    })

    const { default: App } = await import('@/App')
    render(<App />)

    await waitFor(() => {
      // Should NOT show setup wizard
      expect(screen.queryByText(/get started/i)).not.toBeInTheDocument()
    })

    expect(api.isSetup).toHaveBeenCalledOnce()
  })
})
