/**
 * ProjectTab — displays project info for a session with copyable paths.
 */
import { useState, useCallback } from 'react';

interface ProjectTabProps {
  projectPath: string;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for insecure contexts
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      title="Copy path"
      style={{
        background: 'none',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '3px',
        color: copied ? 'var(--accent-green, #50fa7b)' : 'var(--text-dim, #555)',
        cursor: 'pointer',
        padding: '2px 5px',
        fontFamily: 'var(--font-mono)',
        fontSize: '9px',
        fontWeight: 600,
        letterSpacing: '0.5px',
        transition: 'all 0.15s',
        flexShrink: 0,
      }}
    >
      {copied ? 'OK' : 'CP'}
    </button>
  );
}

function PathRow({ label, path }: { label: string; path: string }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 0',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          color: 'var(--text-dim, #555)',
          fontSize: '9px',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.5px',
          marginBottom: '2px',
        }}>
          {label}
        </div>
        <div style={{
          color: 'var(--text-primary)',
          fontSize: '11px',
          wordBreak: 'break-all' as const,
          lineHeight: 1.4,
        }}>
          {path}
        </div>
      </div>
      <CopyButton text={path} />
    </div>
  );
}

export default function ProjectTab({ projectPath }: ProjectTabProps) {
  // Split the path to also show individual components
  const parts = projectPath ? projectPath.split('/').filter(Boolean) : [];
  const parentDir = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '';
  const projectName = parts.length > 0 ? parts[parts.length - 1] : '';

  return (
    <div style={{ padding: '12px', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
      <div style={{
        color: 'var(--text-secondary)',
        marginBottom: '8px',
        fontSize: '10px',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}>
        Project Info
      </div>

      <PathRow label="Full Path" path={projectPath} />
      {parentDir && <PathRow label="Parent Directory" path={parentDir} />}
      {projectName && <PathRow label="Project Name" path={projectName} />}
    </div>
  );
}
