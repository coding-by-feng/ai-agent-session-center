// queryEngine.js — Query builder and search functions for session data
import db from './db.js';

export function searchSessions({ query, project, status, dateFrom, dateTo, archived, sortBy = 'started_at', sortDir = 'desc', page = 1, pageSize = 50 } = {}) {
  const conditions = [];
  const params = {};

  if (project) {
    conditions.push('s.project_path = @project');
    params.project = project;
  }
  if (status) {
    conditions.push('s.status = @status');
    params.status = status;
  }
  if (dateFrom) {
    conditions.push('s.started_at >= @dateFrom');
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    conditions.push('s.started_at <= @dateTo');
    params.dateTo = dateTo;
  }

  if (archived === 'true' || archived === true) {
    conditions.push('s.archived = 1');
  } else if (archived !== 'all') {
    conditions.push('(s.archived IS NULL OR s.archived = 0)');
  }

  let fromClause = 'sessions s';
  if (query) {
    fromClause = `sessions s
      INNER JOIN prompts p ON p.session_id = s.id
      INNER JOIN prompts_fts pf ON pf.rowid = p.id`;
    conditions.push('prompts_fts MATCH @query');
    params.query = query;
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Whitelist allowed sort columns
  const allowedSorts = ['started_at', 'ended_at', 'last_activity_at', 'total_tool_calls', 'total_prompts', 'project_name'];
  const safeSort = allowedSorts.includes(sortBy) ? sortBy : 'started_at';
  const safeDir = sortDir === 'asc' ? 'ASC' : 'DESC';

  const countSql = `SELECT COUNT(DISTINCT s.id) as total FROM ${fromClause} ${whereClause}`;
  const totalRow = db.prepare(countSql).get(params);
  const total = totalRow ? totalRow.total : 0;

  const offset = (page - 1) * pageSize;
  params.limit = pageSize;
  params.offset = offset;

  const dataSql = `SELECT DISTINCT s.* FROM ${fromClause} ${whereClause}
    ORDER BY s.${safeSort} ${safeDir}
    LIMIT @limit OFFSET @offset`;
  const sessions = db.prepare(dataSql).all(params);

  return { sessions, total, page, pageSize };
}

export function getSessionDetail(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  const prompts = db.prepare('SELECT * FROM prompts WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId);
  const responses = db.prepare('SELECT * FROM responses WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId);
  const tool_calls = db.prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId);
  const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId);
  const notes = db.prepare('SELECT * FROM session_notes WHERE session_id = ? ORDER BY created_at DESC').all(sessionId);

  return { session, prompts, responses, tool_calls, events, notes };
}

export function getDistinctProjects() {
  return db.prepare(`
    SELECT DISTINCT project_path, project_name
    FROM sessions
    WHERE project_path IS NOT NULL
    ORDER BY project_name ASC
  `).all();
}

export function getTimeline({ dateFrom, dateTo, granularity = 'day', project } = {}) {
  const conditions = [];
  const params = {};

  if (dateFrom) {
    conditions.push('s.started_at >= @dateFrom');
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    conditions.push('s.started_at <= @dateTo');
    params.dateTo = dateTo;
  }
  if (project) {
    conditions.push('s.project_path = @project');
    params.project = project;
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Build strftime format based on granularity
  let fmt;
  switch (granularity) {
    case 'hour': fmt = '%Y-%m-%d %H:00'; break;
    case 'week': fmt = '%Y-W%W'; break;
    case 'month': fmt = '%Y-%m'; break;
    default: fmt = '%Y-%m-%d'; break;
  }

  const sql = `
    SELECT
      strftime('${fmt}', s.started_at / 1000, 'unixepoch') AS period,
      COUNT(DISTINCT s.id) AS session_count,
      COALESCE(SUM(s.total_prompts), 0) AS prompt_count,
      COALESCE(SUM(s.total_tool_calls), 0) AS tool_call_count
    FROM sessions s
    ${whereClause}
    GROUP BY period
    ORDER BY period ASC
  `;

  const buckets = db.prepare(sql).all(params);
  return { buckets };
}

export function fullTextSearch({ query, type = 'all', page = 1, pageSize = 50 } = {}) {
  if (!query) return { results: [], total: 0 };

  const results = [];
  const params = { query };
  const offset = (page - 1) * pageSize;

  if (type === 'all' || type === 'prompts') {
    const promptSql = `
      SELECT
        p.session_id,
        s.project_name,
        'prompt' AS type,
        highlight(prompts_fts, 0, '<mark>', '</mark>') AS text_snippet,
        p.timestamp
      FROM prompts_fts pf
      INNER JOIN prompts p ON p.id = pf.rowid
      INNER JOIN sessions s ON s.id = p.session_id
      WHERE prompts_fts MATCH @query
      ORDER BY p.timestamp DESC
    `;
    results.push(...db.prepare(promptSql).all(params));
  }

  if (type === 'all' || type === 'responses') {
    const responseSql = `
      SELECT
        r.session_id,
        s.project_name,
        'response' AS type,
        highlight(responses_fts, 0, '<mark>', '</mark>') AS text_snippet,
        r.timestamp
      FROM responses_fts rf
      INNER JOIN responses r ON r.id = rf.rowid
      INNER JOIN sessions s ON s.id = r.session_id
      WHERE responses_fts MATCH @query
      ORDER BY r.timestamp DESC
    `;
    results.push(...db.prepare(responseSql).all(params));
  }

  // Sort combined results by timestamp descending
  results.sort((a, b) => b.timestamp - a.timestamp);

  const total = results.length;
  const paged = results.slice(offset, offset + pageSize);

  return { results: paged, total, page, pageSize };
}
