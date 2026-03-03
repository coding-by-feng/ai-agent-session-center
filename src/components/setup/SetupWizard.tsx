import { useState } from 'react'
import type { SetupConfig } from '@/types/electron'
import WelcomeStep from './steps/WelcomeStep'
import DepsCheckStep from './steps/DepsCheckStep'
import ConfigureStep from './steps/ConfigureStep'
import InstallStep from './steps/InstallStep'
import DoneStep from './steps/DoneStep'
import styles from '@/styles/modules/SetupWizard.module.css'

const defaultConfig: SetupConfig = {
  port: 3333,
  enabledClis: ['claude'],
  hookDensity: 'medium',
  debug: false,
  sessionHistoryHours: 24,
}

export interface StepProps {
  config: SetupConfig
  setConfig: React.Dispatch<React.SetStateAction<SetupConfig>>
  onNext: () => void
}

function WizardHeader({ step, total }: { step: number; total: number }) {
  const labels = ['Welcome', 'Check Deps', 'Configure', 'Install', 'Done']
  return (
    <div className={styles.header}>
      <div className={styles.progressBar}>
        <div
          className={styles.progressFill}
          style={{ width: `${(step / (total - 1)) * 100}%` }}
        />
      </div>
      <div className={styles.steps}>
        {labels.map((label, i) => (
          <span
            key={label}
            className={`${styles.stepLabel} ${i === step ? styles.active : ''} ${i < step ? styles.done : ''}`}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function SetupWizard() {
  const [step, setStep] = useState(0)
  const [config, setConfig] = useState<SetupConfig>(defaultConfig)
  const steps = [WelcomeStep, DepsCheckStep, ConfigureStep, InstallStep, DoneStep]
  const Step = steps[step]
  return (
    <div className={styles.wizard}>
      <WizardHeader step={step} total={steps.length} />
      <div className={styles.content}>
        <Step config={config} setConfig={setConfig} onNext={() => setStep(s => s + 1)} />
      </div>
    </div>
  )
}
