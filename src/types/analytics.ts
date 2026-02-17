/**
 * Analytics types for AI Agent Session Center.
 * Used by the analytics panel and DB analytics endpoints.
 */

// ---------------------------------------------------------------------------
// Summary Stats (GET /api/db/analytics/summary)
// ---------------------------------------------------------------------------

export interface AnalyticsSummary {
  total_sessions: number;
  active_sessions: number;
  total_prompts: number;
  total_tool_calls: number;
  most_used_tool: { tool_name: string; count: number } | null;
  busiest_project: { project_path: string; name: string; count: number } | null;
}

// ---------------------------------------------------------------------------
// Tool Breakdown (GET /api/db/analytics/tools)
// ---------------------------------------------------------------------------

export interface ToolBreakdownEntry {
  tool_name: string;
  count: number;
  percentage: number;
}

export type ToolBreakdown = ToolBreakdownEntry[];

// ---------------------------------------------------------------------------
// Active Projects (GET /api/db/analytics/projects)
// ---------------------------------------------------------------------------

export interface ActiveProject {
  project_path: string;
  project_name: string;
  session_count: number;
  last_activity: number;
}

// ---------------------------------------------------------------------------
// Heatmap (GET /api/db/analytics/heatmap)
// ---------------------------------------------------------------------------

export interface HeatmapEntry {
  day_of_week: number; // 0 (Mon) - 6 (Sun)
  hour: number;        // 0 - 23
  count: number;
}

export type HeatmapData = HeatmapEntry[];

// ---------------------------------------------------------------------------
// Distinct Projects (GET /api/db/projects)
// ---------------------------------------------------------------------------

export interface DistinctProject {
  project_path: string;
  project_name: string;
}
