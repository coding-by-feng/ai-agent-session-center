// analytics.js — Aggregation and analytics queries
import db from './db.js';

export function getToolUsageBreakdown({ dateFrom, dateTo, project, sessionId } = {}) {
  const conditions = [];
  const params = {};

  if (sessionId) {
    conditions.push('tc.session_id = @sessionId');
    params.sessionId = sessionId;
  }
  if (project) {
    conditions.push('s.project_path = @project');
    params.project = project;
  }
  if (dateFrom) {
    conditions.push('tc.timestamp >= @dateFrom');
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    conditions.push('tc.timestamp <= @dateTo');
    params.dateTo = dateTo;
  }

  const needsJoin = project != null;
  const fromClause = needsJoin
    ? 'tool_calls tc INNER JOIN sessions s ON s.id = tc.session_id'
    : 'tool_calls tc';
  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const totalRow = db.prepare(`SELECT COUNT(*) as total FROM ${fromClause} ${whereClause}`).get(params);
  const totalCount = totalRow ? totalRow.total : 0;

  const sql = `
    SELECT
      tc.tool_name AS name,
      COUNT(*) AS count
    FROM ${fromClause}
    ${whereClause}
    GROUP BY tc.tool_name
    ORDER BY count DESC
  `;
  const rows = db.prepare(sql).all(params);

  const tools = rows.map(r => ({
    name: r.name,
    count: r.count,
    percentage: totalCount > 0 ? Math.round((r.count / totalCount) * 10000) / 100 : 0
  }));

  return { tools };
}

export function getDurationTrends({ dateFrom, dateTo, project, granularity = 'day' } = {}) {
  const conditions = [];
  const params = {};

  if (dateFrom) {
    conditions.push('started_at >= @dateFrom');
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    conditions.push('started_at <= @dateTo');
    params.dateTo = dateTo;
  }
  if (project) {
    conditions.push('project_path = @project');
    params.project = project;
  }
  // Only include sessions with both start and end times for duration
  conditions.push('ended_at IS NOT NULL');
  conditions.push('started_at IS NOT NULL');

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  let fmt;
  switch (granularity) {
    case 'hour': fmt = '%Y-%m-%d %H:00'; break;
    case 'week': fmt = '%Y-W%W'; break;
    case 'month': fmt = '%Y-%m'; break;
    default: fmt = '%Y-%m-%d'; break;
  }

  const sql = `
    SELECT
      strftime('${fmt}', started_at / 1000, 'unixepoch') AS period,
      CAST(AVG(ended_at - started_at) AS INTEGER) AS avg_duration_ms,
      COUNT(*) AS session_count
    FROM sessions
    ${whereClause}
    GROUP BY period
    ORDER BY period ASC
  `;

  const buckets = db.prepare(sql).all(params);
  return { buckets };
}

export function getActiveProjects({ dateFrom, dateTo } = {}) {
  const conditions = ['project_path IS NOT NULL'];
  const params = {};

  if (dateFrom) {
    conditions.push('started_at >= @dateFrom');
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    conditions.push('started_at <= @dateTo');
    params.dateTo = dateTo;
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ');

  const sql = `
    SELECT
      project_path,
      project_name,
      COUNT(*) AS session_count,
      COALESCE(SUM(total_prompts), 0) AS total_prompts,
      COALESCE(SUM(total_tool_calls), 0) AS total_tools,
      MAX(last_activity_at) AS last_active_at
    FROM sessions
    ${whereClause}
    GROUP BY project_path
    ORDER BY session_count DESC
  `;

  const projects = db.prepare(sql).all(params);
  return { projects };
}

export function getDailyHeatmap({ dateFrom, dateTo, project } = {}) {
  const conditions = [];
  const params = {};

  if (dateFrom) {
    conditions.push('e.timestamp >= @dateFrom');
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    conditions.push('e.timestamp <= @dateTo');
    params.dateTo = dateTo;
  }
  if (project) {
    conditions.push('s.project_path = @project');
    params.project = project;
  }

  const needsJoin = project != null;
  const fromClause = needsJoin
    ? 'events e INNER JOIN sessions s ON s.id = e.session_id'
    : 'events e';
  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const sql = `
    SELECT
      CAST(strftime('%w', e.timestamp / 1000, 'unixepoch') AS INTEGER) AS day,
      CAST(strftime('%H', e.timestamp / 1000, 'unixepoch') AS INTEGER) AS hour,
      COUNT(*) AS count
    FROM ${fromClause}
    ${whereClause}
    GROUP BY day, hour
    ORDER BY day, hour
  `;

  const cells = db.prepare(sql).all(params);
  return { cells };
}

export function getSummaryStats({ dateFrom, dateTo } = {}) {
  const conditions = [];
  const params = {};

  if (dateFrom) {
    conditions.push('started_at >= @dateFrom');
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    conditions.push('started_at <= @dateTo');
    params.dateTo = dateTo;
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total_sessions,
      COALESCE(SUM(total_prompts), 0) AS total_prompts,
      COALESCE(SUM(total_tool_calls), 0) AS total_tool_calls,
      SUM(CASE WHEN status = 'idle' OR status = 'working' OR status = 'prompting' THEN 1 ELSE 0 END) AS active_sessions,
      CAST(AVG(CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL THEN ended_at - started_at END) AS INTEGER) AS avg_session_duration_ms
    FROM sessions
    ${whereClause}
  `).get(params) || {};

  // Total responses
  const responseRow = db.prepare(`
    SELECT COUNT(*) AS total_responses
    FROM responses r
    INNER JOIN sessions s ON s.id = r.session_id
    ${whereClause}
  `).get(params);
  stats.total_responses = responseRow ? responseRow.total_responses : 0;

  // Most used tool
  const toolRow = db.prepare(`
    SELECT tc.tool_name AS name, COUNT(*) AS count
    FROM tool_calls tc
    INNER JOIN sessions s ON s.id = tc.session_id
    ${whereClause}
    GROUP BY tc.tool_name
    ORDER BY count DESC
    LIMIT 1
  `).get(params);
  stats.most_used_tool = toolRow ? { name: toolRow.name, count: toolRow.count } : null;

  // Busiest project
  const projectRow = db.prepare(`
    SELECT project_name AS name, COUNT(*) AS sessions
    FROM sessions
    ${whereClause !== '' ? whereClause + ' AND' : 'WHERE'} project_name IS NOT NULL
    GROUP BY project_path
    ORDER BY sessions DESC
    LIMIT 1
  `).get(params);
  stats.busiest_project = projectRow ? { name: projectRow.name, sessions: projectRow.sessions } : null;

  return stats;
}
