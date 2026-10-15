import { useEffect, useRef, type ReactNode } from 'react';
import Modal from '@/components/ui/Modal';
import { useUiStore } from '@/stores/uiStore';
import styles from '@/styles/modules/CloudResources.module.css';
export default function CloudDialog({
  title,
  children,
  onClose,
  returnFocus,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const origin = useRef(returnFocus ?? (document.activeElement as HTMLElement | null));
  useEffect(() => {
    const target = origin.current;
    useUiStore.getState().openModal('cloud-review');
    return () => {
      if (useUiStore.getState().activeModal === 'cloud-review') useUiStore.getState().closeModal();
      if (target?.isConnected) target.focus();
    };
  }, []);
  return (
    <Modal modalId="cloud-review" title={title} onClose={onClose} panelClassName={styles.dialog}>
      {children}
    </Modal>
  );
}
