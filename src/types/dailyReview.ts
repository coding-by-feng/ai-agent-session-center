// ---------------------------------------------------------------------------
// Daily review (Nov 20 2026) — one day's typed prompts, grouped project › room › session,
// with the day's summary when one was written. Shared by the server and the PROMPTS Days view.
// ---------------------------------------------------------------------------

export interface DailyReviewPrompt {
  id: number;
  /** At most `DAILY_TEXT_MAX` characters in what the server answers. */
  text: string;
  timestamp: number;
  /** The prompt's real length, present only when `text` was clipped. */
  fullLength?: number;
}

export interface DailyReviewSession {
  sessionId: string;
  /** Through `sessionDisplayTitle()`, like every other name in the app. */
  title: string;
  promptCount: number;
  firstAt: number;
  lastAt: number;
  /** Oldest first. */
  prompts: DailyReviewPrompt[];
}

export interface DailyReviewRoom {
  /** The room the session is in now; `NO_ROOM` when it is in none. */
  name: string;
  promptCount: number;
  /** In the order they started that day. */
  sessions: DailyReviewSession[];
}

export interface DailyReviewProject {
  name: string;
  path: string | null;
  promptCount: number;
  sessionCount: number;
  /** Busiest first; `NO_ROOM` last. */
  rooms: DailyReviewRoom[];
}

export interface DailySummary {
  /** "• " bullets, one per line. */
  text: string;
  model: string;
  /** How many prompts it was written from. */
  promptCount: number;
  generatedAt: number;
  /** A prompt was typed that day after it was written. */
  stale: boolean;
}

export interface DailyReview {
  /** YYYY-MM-DD, the Mac's local day. */
  day: string;
  promptCount: number;
  sessionCount: number;
  projectCount: number;
  /** Busiest first. */
  projects: DailyReviewProject[];
  summary: DailySummary | null;
  /** This day's summary is being written right now. */
  summarizing: boolean;
}
