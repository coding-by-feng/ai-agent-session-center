/**
 * FloatingTerminalRoot — renders all currently-open floating terminal sessions.
 *
 * Mounted once in AppLayout. Subscribes to floatingSessionsStore and renders
 * one FloatingTerminalPanel per active float.
 */
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import FloatingTerminalPanel from './FloatingTerminalPanel';

export default function FloatingTerminalRoot() {
  const floats = useFloatingSessionsStore((s) => s.floats);
  const close = useFloatingSessionsStore((s) => s.close);
  return (
    <>
      {floats.map((f, i) => (
        <FloatingTerminalPanel
          key={f.terminalId}
          terminalId={f.terminalId}
          label={f.label}
          stackIndex={i}
          onClose={() => close(f.terminalId)}
        />
      ))}
    </>
  );
}
