// Types for install-extra-agents.js (plain JS: it also runs from the npm package's CLI installer).
export const EXTRA_AGENT_CLIS: readonly ['opencode', 'antigravity'];
export const OPENCODE_PLUGIN_MARKER: string;
export const AGY_HOOK_NAME: string;
export const AGY_DENSITY_EVENTS: Record<'high' | 'medium' | 'low', string[]>;
export function opencodePluginPaths(home?: string): { dir: string; file: string };
export function agyPaths(home?: string): { configDir: string; hooksFile: string; relayDir: string; relay: string; relayCommand: string };
export function installOpencodePlugin(opts: { hooksDir: string; home?: string }): 'installed' | 'unchanged';
export function removeOpencodePlugin(opts?: { home?: string }): boolean;
export function opencodePluginInstalled(home?: string): boolean;
export function configureAgyHooks(config: Record<string, unknown>, events: string[], relayCommand: string): Record<string, unknown>;
export function removeAgyHooks(config: Record<string, unknown>): { config: Record<string, unknown>; removed: boolean };
export function agyHookEvents(config: Record<string, unknown>): string[];
export function installAgyHooks(opts: { hooksDir: string; density?: string; home?: string }): { relay: 'installed' | 'unchanged'; hooks: 'registered' | 'unchanged' };
export function uninstallAgyHooks(opts?: { home?: string }): { hooksRemoved: boolean; relayRemoved: boolean };
export function readAgyHookEvents(home?: string): string[];
