import { useState, useEffect } from 'react'
import type { DepCheckResult } from '@/types/electron'
import type { StepProps } from '../SetupWizard'
import styles from '@/styles/modules/SetupWizard.module.css'

const REQUIRED_DEPS: Record<string, string[]> = {
  darwin: ['curl'],
  win32: ['powershell'],
}

const OPTIONAL_DEPS: Record<string, string[]> = {
  darwin: ['jq'],
  win32: [],
}

export default function DepsCheckStep({ onNext }: StepProps) {
  const [deps, setDeps] = useState<Record<string, DepCheckResult> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!window.electronAPI) {
      setDeps({})
      return
    }
    window.electronAPI.checkDeps()
      .then(setDeps)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [])

  if (error) {
    return (
      <div className={styles.stepContainer}>
        <div className={styles.errorMessage}>Failed to check dependencies: {error}</div>
        <button className={styles.primaryBtn} onClick={onNext}>
          Continue Anyway
        </button>
      </div>
    )
  }

  if (!deps) {
    return (
      <div className={styles.stepContainer}>
        <div className={styles.spinner} />
        <div className={styles.loadingText}>Checking dependencies...</div>
      </div>
    )
  }

  const platform = window.electronAPI?.platform ?? 'darwin'
  const requiredNames = REQUIRED_DEPS[platform] ?? []
  const optionalNames = OPTIONAL_DEPS[platform] ?? []
  const allRequiredOk = requiredNames.every(name => deps[name]?.ok !== false)

  return (
    <div className={styles.stepContainer}>
      <div className={styles.depsList}>
        {requiredNames.map(name => {
          const dep = deps[name]
          const ok = dep?.ok !== false
          return (
            <div key={name} className={styles.depItem}>
              <span className={`${styles.depIcon} ${ok ? styles.ok : styles.error}`}>
                {ok ? '\u2713' : '\u2717'}
              </span>
              <div className={styles.depInfo}>
                <span className={styles.depName}>
                  {name}
                  {dep?.version && <span className={styles.depVersion}>v{dep.version}</span>}
                </span>
                {!ok && dep?.hint && <div className={styles.depHint}>{dep.hint}</div>}
              </div>
            </div>
          )
        })}
        {optionalNames.map(name => {
          const dep = deps[name]
          const ok = dep?.ok !== false
          return (
            <div key={name} className={styles.depItem}>
              <span className={`${styles.depIcon} ${ok ? styles.ok : styles.warn}`}>
                {ok ? '\u2713' : '!'}
              </span>
              <div className={styles.depInfo}>
                <span className={styles.depName}>
                  {name}
                  {dep?.version && <span className={styles.depVersion}>v{dep.version}</span>}
                </span>
                {!ok && dep?.hint && <div className={styles.depHint}>{dep.hint}</div>}
              </div>
              <span className={styles.depOptional}>optional</span>
            </div>
          )
        })}
      </div>

      {allRequiredOk ? (
        <button className={styles.primaryBtn} onClick={onNext}>
          Continue
        </button>
      ) : (
        <div className={styles.errorMessage}>
          Fix required dependencies above before continuing.
        </div>
      )}
    </div>
  )
}
