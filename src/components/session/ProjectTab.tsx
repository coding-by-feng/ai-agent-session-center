/**
 * ProjectTab — displays project info for a session.
 */

interface ProjectTabProps {
  projectPath: string;
}

export default function ProjectTab({ projectPath }: ProjectTabProps) {
  return (
    <div style={{ padding: '12px', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
      <div style={{ color: 'var(--text-secondary)', marginBottom: '8px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Project Path
      </div>
      <div style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>
        {projectPath}
      </div>
    </div>
  );
}
