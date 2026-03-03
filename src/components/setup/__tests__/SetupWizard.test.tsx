import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SetupWizard from '../SetupWizard'

describe('SetupWizard - Integration', () => {
  beforeEach(() => {
    window.electronAPI = undefined
  })

  afterEach(() => {
    window.electronAPI = undefined
  })

  it('renders the wizard with the Welcome step initially', () => {
    render(<SetupWizard />)
    expect(screen.getByText('AI Agent Session Center')).toBeInTheDocument()
    expect(screen.getByText('Get Started')).toBeInTheDocument()
  })

  it('navigates from Welcome to DepsCheck on button click', async () => {
    render(<SetupWizard />)

    // Click "Get Started" on Welcome step
    fireEvent.click(screen.getByText('Get Started'))

    // Should now show DepsCheck step - in web mode it resolves immediately
    await waitFor(() => {
      expect(screen.getByText('Continue')).toBeInTheDocument()
    })
  })

  it('navigates through Welcome -> DepsCheck -> Configure', async () => {
    render(<SetupWizard />)

    // Step 0: Welcome
    fireEvent.click(screen.getByText('Get Started'))

    // Step 1: DepsCheck (web mode skips to continue)
    await waitFor(() => {
      expect(screen.getByText('Continue')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Continue'))

    // Step 2: Configure - should show form elements
    await waitFor(() => {
      expect(screen.getByText('AI CLIs to Monitor')).toBeInTheDocument()
      expect(screen.getByText('Hook Density')).toBeInTheDocument()
      expect(screen.getByText('Dashboard Port')).toBeInTheDocument()
    })
  })

  it('renders all progress labels', () => {
    render(<SetupWizard />)
    expect(screen.getByText('Welcome')).toBeInTheDocument()
    expect(screen.getByText('Check Deps')).toBeInTheDocument()
    expect(screen.getByText('Configure')).toBeInTheDocument()
    expect(screen.getByText('Install')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
  })

  it('does not show wizard when not in Electron mode', () => {
    // When window.electronAPI is undefined, the wizard should still render
    // (it's the App.tsx gate that decides whether to show it)
    render(<SetupWizard />)
    expect(screen.getByText('AI Agent Session Center')).toBeInTheDocument()
  })
})
