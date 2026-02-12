/**
 * Configuration types for AI Agent Session Center
 */

import type { SessionStatus } from './session';

/** Server configuration (data/server-config.json merged with defaults) */
export interface ServerConfig {
  port: number;
  hookDensity: 'high' | 'medium' | 'low';
  debug: boolean;
  processCheckInterval: number;
  sessionHistoryHours: number;
  enabledClis: string[];
}

/** Tool category names for approval detection */
export type ToolCategory = 'fast' | 'userInput' | 'medium' | 'slow';

/** Tool timeout configuration (ms per category) */
export type ToolTimeoutConfig = Record<ToolCategory, number>;

/** Waiting reason per tool category */
export type WaitingReasonConfig = Record<ToolCategory, SessionStatus>;

/** Auto-idle timeout configuration (ms per status) */
export interface AutoIdleConfig {
  prompting: number;
  waiting: number;
  working: number;
  approval: number;
  input: number;
}

/** Animation state mapping for a status */
export interface StatusAnimation {
  animationState: string;
  emote: string | null;
}

/** Full status-to-animation mapping */
export type StatusAnimationConfig = Record<string, StatusAnimation>;
