/**
 * LinkifiedText — renders plain text with clickable file paths.
 * File paths are detected via regex; clicking opens the FileOpenChooser
 * popover (open in app / default app / reveal in Finder).
 */
import { useMemo } from 'react';
import { useUiStore } from '@/stores/uiStore';
import { createFilePathRegex } from '@/lib/filePathLink';

interface LinkifiedTextProps {
  text: string;
  projectPath?: string;
}

export default function LinkifiedText({ text, projectPath }: LinkifiedTextProps) {
  const parts = useMemo(() => {
    if (!text || !projectPath) return null;
    const result: Array<{ type: 'text' | 'path'; value: string }> = [];
    let lastIndex = 0;
    // Matches path/to/file.ext, ./… and ../… including non-ASCII segments.
    const filePathRe = createFilePathRegex();
    let match: RegExpExecArray | null;
    while ((match = filePathRe.exec(text)) !== null) {
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
            title={`Choose how to open ${part.value}`}
            onClick={(e) => {
              e.stopPropagation();
              const clean = part.value.replace(/^\.\//, '');
              useUiStore.getState().openFileChooser(clean, projectPath || '', { x: e.clientX, y: e.clientY });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const clean = part.value.replace(/^\.\//, '');
                // No cursor position on keyboard activation — anchor to the link element.
                const rect = e.currentTarget.getBoundingClientRect();
                useUiStore.getState().openFileChooser(clean, projectPath || '', { x: rect.left, y: rect.bottom });
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
