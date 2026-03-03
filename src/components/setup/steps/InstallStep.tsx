import { useState, useEffect, useRef } from 'react'
import type { StepProps } from '../SetupWizard'
import styles from '@/styles/modules/SetupWizard.module.css'

type InstallStatus = 'running' | 'done' | 'error'

export default function InstallStep({ config, onNext }: StepProps) {
  const [logs, setLogs] = useState<string[]>([])
  const [status, setStatus] = useState<InstallStatus>('running')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const startedRef = useRef(false)

  const runInstall = () => {
    if (!window.electronAPI) {
      setLogs(['[skip] No Electron API — running in web mode'])
      setStatus('done')
      setTimeout(onNext, 1500)
      return
    }

    setLogs([])
    setStatus('running')
    setErrorMsg(null)

    window.electronAPI.onInstallLog((line: string) => {
      if (line === 'DONE') {
        setStatus('done')
        setTimeout(onNext, 1500)
        return
      }
      setLogs(prev => [...prev, line])
    })

    window.electronAPI.installHooks({
      hookDensity: config.hookDensity,
      enabledClis: config.enabledClis,
    }).catch((err: unknown) => {
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : String(err))
    })
  }

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    runInstall()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs])

  const handleRetry = () => {
    startedRef.current = false
    runInstall()
  }

  return (
    <div className={styles.stepContainer}>
      <div className={styles.logContainer}>
        <div className={styles.logStatus}>
          {status === 'running' && (
            <>
              <div className={`${styles.spinner} ${styles.spinnerSmall}`} />
              <span className={styles.logStatusText}>Installing hooks...</span>
            </>
          )}
          {status === 'done' && (
            <>
              <span className={styles.checkmark}>{'\u2713'}</span>
              <span className={`${styles.logStatusText} ${styles.logStatusDone}`}>
                Installation complete
              </span>
            </>
          )}
          {status === 'error' && (
            <span className={`${styles.logStatusText} ${styles.logStatusError}`}>
              Installation failed
            </span>
          )}
        </div>

        <pre ref={logRef} className={styles.logViewer}>
          {logs.join('\n')}
        </pre>

        {errorMsg && (
          <div className={styles.errorMessage}>{errorMsg}</div>
        )}

        {status === 'error' && (
          <button className={styles.primaryBtn} onClick={handleRetry}>
            Retry
          </button>
        )}
      </div>
    </div>
  )
}
