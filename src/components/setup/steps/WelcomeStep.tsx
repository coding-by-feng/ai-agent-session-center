import type { StepProps } from '../SetupWizard'
import styles from '@/styles/modules/SetupWizard.module.css'

export default function WelcomeStep({ onNext }: StepProps) {
  return (
    <div className={styles.stepContainer}>
      <div className={styles.logo}>AI Agent Session Center</div>
      <p className={styles.tagline}>
        Monitor all your AI coding agents in one cyberdrome dashboard.
        Claude Code, Gemini CLI, and Codex — tracked in real time.
      </p>
      <button className={styles.primaryBtn} onClick={onNext}>
        Get Started
      </button>
    </div>
  )
}
