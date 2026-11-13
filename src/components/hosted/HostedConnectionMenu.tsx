import { create } from 'zustand';
import Menu from '@/components/ui/Menu';
import { hostedParent } from '@/lib/hosted';
import { useWsStore } from '@/stores/wsStore';
import styles from './hosted.module.css';

export const useHostedControls = create<{ pair: (() => void) | null }>(() => ({ pair: null }));

/** Header-owned trigger: no fixed overlay in the terminal or composer area. */
export default function HostedConnectionMenu() {
  const connected = useWsStore(s => s.connected && s.snapshotReceived);
  const pair = useHostedControls(s => s.pair);
  if (!hostedParent()) return null;
  const status = connected ? '已连接' : '连接中断';
  return <Menu label="工作区连接" triggerLabel={`工作区连接：${status}`}
    plainTrigger={{ className: styles.connectionTrigger, content: <span aria-hidden="true" className={connected ? styles.connectedDot : styles.disconnectedDot}>●</span> }}
    sections={[{id:'connection', title:status, items:[
      ...(pair ? [{kind:'action' as const, id:'pair', label:'配对手机', onSelect:pair}] : []),
      ...(!connected ? [{kind:'action' as const, id:'reconnect', label:'重新连接', onSelect:()=>window.location.reload()}] : []),
    ]}]}
    footer={<span role="status">{connected ? 'Hosted Lite connected' : '连接暂时中断，请检查网络后重试。'}</span>}
  />;
}
