// AppErrorBoundary.tsx — the last catch around every root render (main.tsx).
//
// Without it, any error React can't place (most often a lazy screen whose chunk vanished after the
// Mac's AASC was updated — see lib/chunkReload.ts) unmounts the whole tree and leaves an empty
// white page. This shows what happened and a Reload button instead. A class component because
// React has no hook form of an error boundary.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import styles from '@/styles/modules/AppErrorBoundary.module.css';

interface Props {
  children: ReactNode;
  /** Defaults to a full page reload; injectable for tests. */
  onReload?: () => void;
}

interface State {
  failed: boolean;
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('AASC root crashed:', error, info.componentStack);
  }

  private readonly reload = (): void => {
    if (this.props.onReload) this.props.onReload();
    else window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={styles.screen} role="alert">
        <div className={styles.card}>
          <h1 className={styles.title}>AASC couldn&apos;t load this screen</h1>
          <p className={styles.body}>
            The Mac may have been updated or gone offline while this page was open.
          </p>
          <button type="button" className={styles.reload} onClick={this.reload}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
