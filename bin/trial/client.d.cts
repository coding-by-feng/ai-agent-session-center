export interface TrialStatus {
  available: boolean;
  mode: 'native_qa';
  policyVersion: 'native-qa-v1';
  runtime: 'claude-code';
  client: 'aasc';
  turnLimit: 3;
  inputLimit: number;
  contextTokenLimit: number;
  outputTokenLimit: number;
  historyPairs: number;
  timeoutMs: number;
  concurrentTurns: 1;
}
export interface TrialTurn {
  id: string;
  requestKey: string;
  prompt: string;
  answer: string | null;
  status: 'pending' | 'completed' | 'failed' | 'uncertain';
  createdAt: number;
  reason?: string | null;
  truncated?: number;
}
export interface TrialSession {
  id: string;
  state: 'active' | 'expired' | 'exhausted' | 'revoked';
  remaining: number;
  completed: number;
  reserved: number;
  expiresAt: number;
  transcriptExpiresAt: number;
  turns: TrialTurn[];
}
export interface PendingTrialRequest {
  requestKey: string;
  prompt: string;
}
/** Private main-process/storage data. Never send this object to a renderer. */
export interface LocalTrialState {
  version: 1;
  cookie: string | null;
  pending: PendingTrialRequest | null;
}
export interface TrialStore {
  load(): LocalTrialState | null;
  save(state: LocalTrialState | null): void;
}
export interface TrialSnapshot {
  status: TrialStatus | null;
  session: TrialSession | null;
  pending: PendingTrialRequest | null;
  busy: boolean;
}
export interface TrialClient {
  status(): Promise<TrialStatus>;
  state(): Promise<TrialSnapshot>;
  getSnapshot(): TrialSnapshot;
  activate(code: string): Promise<TrialSnapshot>;
  ask(prompt: string): Promise<TrialSnapshot>;
  retry(): Promise<TrialSnapshot>;
  logout(): Promise<TrialSnapshot>;
}
export class TrialClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status?: number);
}
export const DEFAULT_TRIAL_ORIGIN: 'https://xclaude.dev';
export function createTrialClient(options: {
  store: TrialStore;
  /** Production is fixed; explicit loopback HTTP origins are for local integration tests. */
  origin?: string;
  fetch?: typeof fetch;
  randomUUID?: () => string;
}): TrialClient;
export function sanitizeTerminalText(value: string): string;
