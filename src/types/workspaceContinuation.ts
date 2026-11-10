export interface ContinuationDraft {
  text: string;
  images: Array<{ name: string; dataUrl: string }>;
  type: 'once' | 'loop' | 'schedule';
  intervalValue: number;
  intervalUnit: 'sec' | 'min' | 'hour';
  runAt: string;
}
export interface WorkspaceContinuation {
  sourceId: string;
  selectedSessionId: string | null;
  drafts: Array<{ sessionId: string; draft: ContinuationDraft }>;
  revision: number;
  updatedAt: number;
}
export type ContinuationWrite = Omit<WorkspaceContinuation, 'revision' | 'updatedAt'> & {
  revision: number;
  adopt?: Array<{ sourceId: string; revision: number }>;
};
