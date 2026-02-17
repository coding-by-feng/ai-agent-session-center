import { useState, useEffect, useCallback } from 'react';
import styles from '@/styles/modules/Modal.module.css';

interface Toast {
  id: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
  duration: number;
}

const DEFAULT_DURATION = 3000;

// Module-level subscriber pattern so toasts can be triggered from anywhere
type ToastListener = (toast: Toast) => void;
const listeners = new Set<ToastListener>();

export function showToast(
  message: string,
  type: Toast['type'] = 'info',
  duration = DEFAULT_DURATION,
): void {
  const toast: Toast = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    message,
    type,
    duration,
  };
  for (const listener of listeners) {
    listener(toast);
  }
}

const typeMap: Record<Toast['type'], string> = {
  info: 'var(--accent-cyan, #00e5ff)',
  success: 'var(--accent-green, #00ff88)',
  error: 'var(--accent-red, #ff3355)',
  warning: 'var(--accent-orange, #ff9100)',
};

export default function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((toast: Toast) => {
    setToasts((prev) => [...prev, toast]);
  }, []);

  useEffect(() => {
    listeners.add(addToast);
    return () => {
      listeners.delete(addToast);
    };
  }, [addToast]);

  // Auto-dismiss timers
  useEffect(() => {
    if (toasts.length === 0) return;

    const timers = toasts.map((toast) =>
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, toast.duration),
    );

    return () => timers.forEach(clearTimeout);
  }, [toasts]);

  if (toasts.length === 0) return null;

  return (
    <div className={styles.toastContainer}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={styles.toast}
          style={{ borderColor: typeMap[toast.type] }}
        >
          <span className={styles.toastMsg}>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
