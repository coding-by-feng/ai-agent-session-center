import { useEffect, useRef, type ReactNode } from 'react';
import Modal from '@/components/ui/Modal';
import { useUiStore } from '@/stores/uiStore';
import styles from '@/styles/modules/CloudResources.module.css';
/** The one modal id every cloud review and action dialog opens under. */
export const CLOUD_DIALOG_ID = 'cloud-review';
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
    useUiStore.getState().openModal(CLOUD_DIALOG_ID);
    return () => {
      if (useUiStore.getState().activeModal === CLOUD_DIALOG_ID) useUiStore.getState().closeModal();
      if (target?.isConnected) target.focus();
    };
  }, []);
  return (
    <Modal modalId={CLOUD_DIALOG_ID} title={title} onClose={onClose} panelClassName={styles.dialog}>
      {children}
    </Modal>
  );
}
