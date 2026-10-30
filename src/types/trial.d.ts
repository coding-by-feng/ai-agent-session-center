import type { TrialSnapshot } from '../../bin/trial/client.cjs';
export type {
  TrialStatus,
  TrialSession,
  TrialSnapshot,
  TrialTurn,
} from '../../bin/trial/client.cjs';
export type TrialResult =
  | { ok: true; data: TrialSnapshot }
  | { ok: false; error: string; data?: TrialSnapshot };
export interface NativeTrialAPI {
  refresh(): Promise<TrialResult>;
  activate(code: string): Promise<TrialResult>;
  ask(prompt: string): Promise<TrialResult>;
  retry(): Promise<TrialResult>;
  logout(): Promise<TrialResult>;
}
