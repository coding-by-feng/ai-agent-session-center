import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './Trial.module.css';
const TrialPanel = lazy(() => import('./TrialPanel'));

export default function TrialLauncher() {
  const api = window.electronAPI?.trial;
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);
  function close() {
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus();
  }
  if (!api) return null;
  return (
    <>
      <button ref={trigger} className={styles.launcher} onClick={() => setOpen(true)}>
        使用体验码
      </button>
      {open &&
        createPortal(
          <dialog
            data-aasc-trial-dialog
            ref={dialog}
            className={styles.dialog}
            aria-labelledby="aasc-trial-title"
            onCancel={close}
            onClick={(e) => e.stopPropagation()}
          >
            <header className={styles.header}>
              <div>
                <span className={styles.eyebrow}>XCLAUDE</span>
                <h2 id="aasc-trial-title">AASC 问答体验</h2>
              </div>
              <button aria-label="关闭体验窗口" onClick={close}>
                关闭
              </button>
            </header>
            <Suspense fallback={<p className={styles.note}>正在载入体验…</p>}>
              <TrialPanel api={api} />
            </Suspense>
          </dialog>,
          document.body,
        )}
    </>
  );
}
