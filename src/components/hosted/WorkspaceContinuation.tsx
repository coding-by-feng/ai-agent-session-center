import { useContinuationState, useWorkspaceContinuation } from '@/hooks/useWorkspaceContinuation';
import { useQueueStore } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import styles from './hosted.module.css';

export default function WorkspaceContinuation() {
  const retry = useWorkspaceContinuation();
  const { error, conflicts } = useContinuationState();
  if (!error && !conflicts.length) return null;
  return (
    <aside className={styles.continuation} aria-label="工作区接续">
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={retry}>
            重试保存与接续
          </button>
        </p>
      )}
      {conflicts.length > 0 && (
        <details>
          <summary>其他窗口的草稿（{conflicts.length}）</summary>
          {conflicts.map((item, index) => (
            <article key={index} className={styles.draftCard}>
              <strong>
                {useSessionStore.getState().sessions.get(item.sessionId)?.title || '会话草稿'}
              </strong>
              <pre>{item.draft.text}</pre>
              {item.draft.images.map((image, i) => (
                <img key={i} src={image.dataUrl} alt={image.name} />
              ))}
              <button
                type="button"
                onClick={() => {
                  useQueueStore.getState().setComposeDraft(item.sessionId, item.draft);
                  useSessionStore.getState().selectSession(item.sessionId);
                  useContinuationState.setState({
                    conflicts: conflicts.filter((_, i) => i !== index),
                  });
                }}
              >
                用这份替换当前草稿
              </button>
            </article>
          ))}
        </details>
      )}
    </aside>
  );
}
