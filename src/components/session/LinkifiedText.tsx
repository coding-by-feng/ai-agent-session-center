/**
 * LinkifiedText — renders plain text with clickable file paths.
 * File paths are detected via regex and open in the PROJECT tab on click.
 */
import { useMemo } from 'react';
import { useUiStore } from '@/stores/uiStore';

interface LinkifiedTextProps {
  text: string;
  projectPath?: string;
}

// Matches: path/to/file.ext, ./path/to/file.ext, ../path/to/file.ext
const FILE_PATH_RE = /(?:\.{0,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.[\w]+/g;

export default function LinkifiedText({ text, projectPath }: LinkifiedTextProps) {
  const parts = useMemo(() => {
    if (!text || !projectPath) return null;
    const result: Array<{ type: 'text' | 'path'; value: string }> = [];
    let lastIndex = 0;
    FILE_PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FILE_PATH_RE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result.push({ type: 'text', value: text.slice(lastIndex, match.index) });
      }
      result.push({ type: 'path', value: match[0] });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      result.push({ type: 'text', value: text.slice(lastIndex) });
    }
    return result.length > 0 && result.some((p) => p.type === 'path') ? result : null;
  }, [text, projectPath]);

  if (!parts) return <>{text}</>;

  return (
    <>
      {parts.map((part, i) =>
        part.type === 'path' ? (
          <span
            key={i}
            role="button"
            tabIndex={0}
            style={{
              color: 'var(--accent-cyan, #00d4ff)',
              textDecoration: 'underline',
              textDecorationColor: 'rgba(0, 212, 255, 0.4)',
              cursor: 'pointer',
            }}
            title={`Open ${part.value} in Project tab`}
            onClick={(e) => {
              e.stopPropagation();
              const clean = part.value.replace(/^\.\//, '');
              useUiStore.getState().openFileInProject(clean, projectPath || '');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const clean = part.value.replace(/^\.\//, '');
                useUiStore.getState().openFileInProject(clean, projectPath || '');
              }
            }}
          >
            {part.value}
          </span>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </>
  );
}
