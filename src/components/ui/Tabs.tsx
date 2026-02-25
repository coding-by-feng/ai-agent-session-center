import type { ReactNode } from 'react';

interface Tab {
  id: string;
  label: string;
  content: ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  containerClassName?: string;
  panelClassName?: string;
  tabListClassName?: string;
  tabClassName?: string;
  activeTabClassName?: string;
}

export default function Tabs({
  tabs,
  activeTab,
  onTabChange,
  containerClassName,
  panelClassName,
  tabListClassName,
  tabClassName,
  activeTabClassName,
}: TabsProps) {
  return (
    <div className={containerClassName}>
      <div
        role="tablist"
        className={tabListClassName}
        style={tabListClassName ? undefined : {
          display: 'flex',
          gap: '2px',
          borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.06))',
          marginBottom: '12px',
        }}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const cls = [tabClassName, isActive && activeTabClassName]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => onTabChange(tab.id)}
              className={cls || undefined}
              style={cls ? undefined : {
                padding: '8px 16px',
                background: isActive
                  ? 'var(--bg-accent, rgba(0,229,255,0.1))'
                  : 'transparent',
                border: 'none',
                borderBottom: isActive
                  ? '2px solid var(--accent-cyan, #00e5ff)'
                  : '2px solid transparent',
                color: isActive
                  ? 'var(--accent-cyan, #00e5ff)'
                  : 'var(--text-secondary, #8888aa)',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontFamily: 'var(--font-mono, monospace)',
                transition: 'color 0.15s, background 0.15s',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className={panelClassName}>
        {tabs.find((t) => t.id === activeTab)?.content}
      </div>
    </div>
  );
}
