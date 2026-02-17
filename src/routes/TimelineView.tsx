import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';
import type { DistinctProject } from '@/types';
import chartStyles from '@/styles/modules/Charts.module.css';

type Granularity = 'hour' | 'day' | 'week';

interface TimelineBucket {
  period: string;
  session_count: number;
  prompt_count: number;
  tool_call_count: number;
}

interface TimelineResponse {
  buckets: TimelineBucket[];
}

function defaultDateFrom(): string {
  const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

function defaultDateTo(): string {
  return new Date().toISOString().split('T')[0];
}

function formatTimeLabel(period: string, granularity: Granularity): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  if (granularity === 'week') {
    const weekMatch = period.match(/^(\d{4})-W(\d{1,2})$/);
    if (weekMatch) {
      const year = parseInt(weekMatch[1], 10);
      const week = parseInt(weekMatch[2], 10);
      const jan1 = new Date(year, 0, 1);
      const dayOffset = (week - 1) * 7 - jan1.getDay() + 1;
      const weekStart = new Date(year, 0, 1 + dayOffset);
      return months[weekStart.getMonth()] + ' ' + weekStart.getDate();
    }
  }

  if (granularity === 'hour') {
    const hourMatch = period.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})$/);
    if (hourMatch) {
      const date = new Date(hourMatch[1] + 'T' + hourMatch[2] + ':' + hourMatch[3] + ':00');
      if (!isNaN(date.getTime())) {
        return months[date.getMonth()] + ' ' + date.getDate() + ' ' + date.getHours().toString().padStart(2, '0') + ':00';
      }
    }
  }

  // Day format
  const date = new Date(period + (period.includes('T') ? '' : 'T00:00:00'));
  if (!isNaN(date.getTime())) {
    return months[date.getMonth()] + ' ' + date.getDate();
  }
  return period;
}

export default function TimelineView() {
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [project, setProject] = useState('');
  const [dateFrom, setDateFrom] = useState(defaultDateFrom);
  const [dateTo, setDateTo] = useState(defaultDateTo);

  const { data: projects } = useQuery<DistinctProject[]>({
    queryKey: ['timeline-projects'],
    queryFn: async () => {
      const res = await fetch('/api/db/projects');
      if (!res.ok) return [];
      return res.json();
    },
  });

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set('granularity', granularity);
    if (project) params.set('project', project);
    if (dateFrom) params.set('dateFrom', String(new Date(dateFrom).getTime()));
    if (dateTo) params.set('dateTo', String(new Date(dateTo + 'T23:59:59').getTime()));
    return params.toString();
  }, [granularity, project, dateFrom, dateTo]);

  const { data: timeline, isLoading } = useQuery<TimelineResponse>({
    queryKey: ['timeline', queryParams],
    queryFn: async () => {
      const res = await fetch(`/api/db/analytics/timeline?${queryParams}`);
      if (!res.ok) return { buckets: [] };
      return res.json();
    },
  });

  const chartData = useMemo(() => {
    if (!timeline?.buckets) return [];
    return timeline.buckets.map((b) => ({
      ...b,
      label: formatTimeLabel(b.period, granularity),
    }));
  }, [timeline, granularity]);

  return (
    <div className={chartStyles.timelineView} data-testid="timeline-view">
      {/* Controls */}
      <div className={chartStyles.timelineControls}>
        <select
          value={granularity}
          onChange={(e) => setGranularity(e.target.value as Granularity)}
        >
          <option value="hour">Hourly</option>
          <option value="day">Daily</option>
          <option value="week">Weekly</option>
        </select>

        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="">All Projects</option>
          {projects?.map((p) => (
            <option key={p.project_path} value={p.project_path}>
              {p.project_name}
            </option>
          ))}
        </select>

        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
        />
      </div>

      {/* Chart */}
      <div className={chartStyles.timelineChart}>
        {isLoading ? (
          <div style={{ color: 'var(--text-dim)', padding: '40px', textAlign: 'center' }}>
            Loading...
          </div>
        ) : chartData.length === 0 ? (
          <div style={{ color: 'var(--text-dim)', padding: '40px', textAlign: 'center' }}>
            No data for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="label"
                stroke="#8892b0"
                fontSize={9}
                interval={chartData.length > 15 ? Math.ceil(chartData.length / 15) : 0}
                angle={chartData.length > 10 || granularity === 'hour' ? -40 : 0}
                textAnchor={chartData.length > 10 || granularity === 'hour' ? 'end' : 'middle'}
                height={granularity === 'hour' ? 60 : 40}
              />
              <YAxis stroke="#8892b0" fontSize={10} />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-card, #12122a)',
                  border: '1px solid var(--accent-cyan, #00e5ff)',
                  borderRadius: '4px',
                  fontSize: '11px',
                  color: 'var(--text-primary, #e0e0ff)',
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: '10px', color: '#8892b0' }}
              />
              <Bar dataKey="session_count" name="Sessions" fill="#00e5ff" opacity={0.85} radius={[2, 2, 0, 0]} />
              <Bar dataKey="prompt_count" name="Prompts" fill="#00ff88" opacity={0.85} radius={[2, 2, 0, 0]} />
              <Bar dataKey="tool_call_count" name="Tool Calls" fill="#ff9800" opacity={0.85} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
