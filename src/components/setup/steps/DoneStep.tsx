import { useState } from 'react'
import type { StepProps } from '../SetupWizard'
import styles from '@/styles/modules/SetupWizard.module.css'

export default function DoneStep({ config }: StepProps) {
  const [launching, setLaunching] = useState(false)

  const handleLaunch = async () => {
    if (!window.electronAPI) return
    setLaunching(true)
    try {
      await window.electronAPI.completeSetup()
    } catch {
      setLaunching(false)
    }
  }

  const handleOpenBrowser = () => {
    if (window.electronAPI) {
      window.electronAPI.openInBrowser()
    }
  }

  const cliLabels = config.enabledClis.join(', ')

  return (
    <div className={styles.stepContainer}>
      <div className={styles.successIcon}>{'\u2713'}</div>
      <h2 className={styles.successHeading}>Setup Complete!</h2>

      <div className={styles.summaryTable}>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Port</span>
          <span className={styles.summaryValue}>{config.port}</span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>CLIs</span>
          <span className={styles.summaryValue}>{cliLabels}</span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Hook Density</span>
          <span className={styles.summaryValue}>{config.hookDensity}</span>
        </div>
      </div>

      <button
        className={styles.launchBtn}
        onClick={handleLaunch}
        disabled={launching || !window.electronAPI}
      >
        {launching ? 'Launching...' : 'Launch Dashboard'}
      </button>

      <div>
        <button className={styles.browserLink} onClick={handleOpenBrowser}>
          Open in browser instead
        </button>
      </div>
    </div>
  )
}
