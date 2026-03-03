import { useMemo, Fragment, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from 'recharts';
import { authFetch } from '@/hooks/useAuth';
import type {
  AnalyticsSummary,
  ToolBreakdownEntry,
  ActiveProject,
  HeatmapEntry,
} from '@/types';
import styles from '@/styles/modules/Charts.module.css';

// ---------------------------------------------------------------------------
// Theme-aware colors for Recharts (reads computed CSS variables)
// ---------------------------------------------------------------------------

function getThemeColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    cyan: s.getPropertyValue('--accent-cyan').trim() || '#00e5ff',
    green: s.getPropertyValue('--accent-green').trim() || '#00ff88',
    orange: s.getPropertyValue('--accent-orange').trim() || '#ff9100',
    textDim: s.getPropertyValue('--text-dim').trim() || '#8888aa',
    textPrimary: s.getPropertyValue('--text-primary').trim() || '#e0e0ff',
    bgCard: s.getPropertyValue('--bg-card').trim() || '#12122a',
    borderSubtle: s.getPropertyValue('--border-subtle').trim() || 'rgba(255,255,255,0.04)',
    bgPrimary: s.getPropertyValue('--bg-primary').trim() || '#0a0a1a',
  };
}

const themeSubscribe = (cb: () => void) => {
  const observer = new MutationObserver(cb);
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
};

function useThemeColors() {
  return useSyncExternalStore(themeSubscribe, getThemeColors, getThemeColors);
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function fetchJson<T>(path: string): Promise<T> {
  const res = await authFetch(path);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function interpolateColor(value: number, max: number, bgColor: string, fgColor: string): string {
  const t = max === 0 ? 0 : Math.max(0, Math.min(1, value / max));
  return `color-mix(in srgb, ${fgColor} ${Math.round(t * 100)}%, ${bgColor})`;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AnalyticsView() {
  const { data: summary } = useQuery({
    queryKey: ['analytics-summary'],
    queryFn: () => fetchJson<AnalyticsSummary>('/api/db/analytics/summary'),
    staleTime: 30_000,
  });

  const { data: tools } = useQuery({
    queryKey: ['analytics-tools'],
    queryFn: () => fetchJson<ToolBreakdownEntry[]>('/api/db/analytics/tools'),
    staleTime: 30_000,
  });

  const { data: projects } = useQuery({
    queryKey: ['analytics-projects'],
    queryFn: () => fetchJson<ActiveProject[]>('/api/db/analytics/projects'),
    staleTime: 30_000,
  });

  const { data: heatmapRaw } = useQuery({
    queryKey: ['analytics-heatmap'],
    queryFn: () => fetchJson<HeatmapEntry[]>('/api/db/analytics/heatmap'),
    staleTime: 30_000,
  });

  return (
    <div className={styles.analyticsView} data-testid="analytics-view">
      {/* Summary Stats */}
      <SummaryStats summary={summary ?? null} />

      {/* Charts Grid */}
      <div className={styles.analyticsGrid}>
        <div className={styles.analyticsCard}>
          <h4>Tool Usage</h4>
          <ToolUsageChart data={tools ?? []} />
        </div>

        <div className={styles.analyticsCard}>
          <h4>Active Projects</h4>
          <ProjectsChart data={projects ?? []} />
        </div>

        <div className={styles.analyticsCard} style={{ gridColumn: '1 / -1' }}>
          <h4>Activity Heatmap</h4>
          <HeatmapGrid data={heatmapRaw ?? []} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary Stats
// ---------------------------------------------------------------------------

function SummaryStats({ summary }: { summary: AnalyticsSummary | null }) {
  const stats = [
    {
      label: 'Total Sessions',
      value: formatNumber(summary?.total_sessions ?? 0),
      detail: 'all time',
    },
    {
      label: 'Total Prompts',
      value: formatNumber(summary?.total_prompts ?? 0),
      detail: 'all time',
    },
    {
      label: 'Total Tool Calls',
      value: formatNumber(summary?.total_tool_calls ?? 0),
      detail: 'all time',
    },
    {
      label: 'Active Sessions',
      value: formatNumber(summary?.active_sessions ?? 0),
      detail: 'currently running',
    },
    {
      label: 'Most Used Tool',
      value: summary?.most_used_tool?.tool_name ?? 'N/A',
      detail: summary?.most_used_tool
        ? formatNumber(summary.most_used_tool.count) + ' calls'
        : '',
    },
    {
      label: 'Busiest Project',
      value: summary?.busiest_project?.name ?? 'N/A',
      detail: summary?.busiest_project
        ? formatNumber(summary.busiest_project.count) + ' sessions'
        : '',
    },
  ];

  return (
    <div className={styles.analyticsSummary}>
      {stats.map((s) => (
        <div key={s.label} className={styles.summaryStat}>
          <div className={styles.statLabel}>{s.label}</div>
          <div className={styles.statValue}>{s.value}</div>
          <div className={styles.statDetail}>{s.detail}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool Usage Bar Chart (Recharts)
// ---------------------------------------------------------------------------

function ToolUsageChart({ data }: { data: ToolBreakdownEntry[] }) {
  const tc = useThemeColors();
  const chartData = data.slice(0, 15);

  if (chartData.length === 0) {
    return <EmptyState message="No tool data" />;
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 28)}>
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 4, right: 40, bottom: 4, left: 100 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={tc.borderSubtle} />
        <XAxis type="number" tick={{ fill: tc.textDim, fontSize: 10 }} />
        <YAxis
          type="category"
          dataKey="tool_name"
          tick={{ fill: tc.textDim, fontSize: 10 }}
          width={96}
        />
        <Tooltip
          contentStyle={{
            background: tc.bgCard,
            border: `1px solid ${tc.cyan}`,
            borderRadius: 4,
            fontSize: 11,
            color: tc.textPrimary,
          }}
          formatter={((value: number, _name: string, props: { payload: ToolBreakdownEntry }) => [
            `${formatNumber(value)} (${props.payload.percentage}%)`,
            'Calls',
          ]) as never}
        />
        <Bar dataKey="count" radius={[0, 4, 4, 0]}>
          {chartData.map((_entry, idx) => (
            <Cell key={idx} fill={tc.cyan} fillOpacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Active Projects Bar Chart (Recharts)
// ---------------------------------------------------------------------------

function ProjectsChart({ data }: { data: ActiveProject[] }) {
  const tc = useThemeColors();
  const chartData = useMemo(
    () =>
      [...data]
        .sort((a, b) => b.session_count - a.session_count)
        .slice(0, 15),
    [data],
  );

  if (chartData.length === 0) {
    return <EmptyState message="No project data" />;
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 28)}>
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 4, right: 40, bottom: 4, left: 120 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={tc.borderSubtle} />
        <XAxis type="number" tick={{ fill: tc.textDim, fontSize: 10 }} />
        <YAxis
          type="category"
          dataKey="project_name"
          tick={{ fill: tc.textDim, fontSize: 10 }}
          width={116}
        />
        <Tooltip
          contentStyle={{
            background: tc.bgCard,
            border: `1px solid ${tc.cyan}`,
            borderRadius: 4,
            fontSize: 11,
            color: tc.textPrimary,
          }}
          formatter={((value: number) => [formatNumber(value) + ' sessions', 'Sessions']) as never}
        />
        <Bar dataKey="session_count" radius={[0, 4, 4, 0]}>
          {chartData.map((_entry, idx) => (
            <Cell key={idx} fill={tc.green} fillOpacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Activity Heatmap (CSS grid, matching legacy)
// ---------------------------------------------------------------------------

function HeatmapGrid({ data }: { data: HeatmapEntry[] }) {
  const tc = useThemeColors();
  const { grid, maxVal } = useMemo(() => {
    const valueMap = new Map<string, number>();
    let max = 0;
    for (const d of data) {
      const key = `${d.day_of_week}-${d.hour}`;
      valueMap.set(key, d.count);
      if (d.count > max) max = d.count;
    }
    return { grid: valueMap, maxVal: max };
  }, [data]);

  if (data.length === 0) {
    return <EmptyState message="No heatmap data" />;
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '40px repeat(24, 14px)',
        gridTemplateRows: '14px repeat(7, 14px)',
        gap: '2px',
        alignItems: 'center',
      }}
    >
      {/* Corner */}
      <div />

      {/* Hour headers */}
      {Array.from({ length: 24 }, (_, h) => (
        <div
          key={`h-${h}`}
          style={{
            fontSize: '9px',
            color: tc.textDim,
            textAlign: 'center',
          }}
        >
          {h}
        </div>
      ))}

      {/* Day rows */}
      {Array.from({ length: 7 }, (_, day) => (
        <Fragment key={`row-${day}`}>
          <div
            style={{
              fontSize: '10px',
              color: tc.textDim,
              textAlign: 'right',
              paddingRight: '4px',
            }}
          >
            {DAY_LABELS[day]}
          </div>
          {Array.from({ length: 24 }, (_, hour) => {
            const val = grid.get(`${day}-${hour}`) ?? 0;
            return (
              <div
                key={`${day}-${hour}`}
                className={styles.heatmapCell}
                title={`${DAY_LABELS[day]} ${String(hour).padStart(2, '0')}:00 - ${val} events`}
                style={{
                  backgroundColor: interpolateColor(val, maxVal, tc.bgPrimary, tc.green),
                }}
              />
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ message }: { message: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        minHeight: '120px',
        color: 'var(--text-dim, #555577)',
        fontSize: '0.85rem',
      }}
    >
      {message}
    </div>
  );
}
