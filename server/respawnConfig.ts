// respawnConfig.ts — the terminal config a server-start respawn rebuilds for a saved session.
//
// The respawn writes its own resume command (command '' skips the auto-launch), so only the
// connection fields and the session's trust choice carry over. Rebuilt field by field, so a
// field left out here is silently lost on every restart: AASC-54's `autoConfirmTrust: false`
// was, which let a restart answer Claude's "trust this folder" prompt for a phone's new folder.

export interface RespawnSource {
  projectPath?: string;
  sshConfig?: {
    host?: string;
    port?: number;
    username?: string;
    authMethod?: 'key' | 'password';
    privateKeyPath?: string;
    workingDir?: string;
    command?: string;
    /** Where the session keeps AASC-54's opt-out (sessionStore puts it on sshConfig). */
    autoConfirmTrust?: false;
  };
}

export interface RespawnTerminalConfig {
  host: string;
  port?: number;
  username?: string;
  authMethod?: 'key' | 'password';
  privateKeyPath?: string;
  workingDir: string;
  command: '';
  autoConfirmTrust?: false;
}

export function respawnTerminalConfig(session: RespawnSource): RespawnTerminalConfig {
  const cfg = session.sshConfig ?? {};
  return {
    host: cfg.host || 'localhost',
    port: cfg.port,
    username: cfg.username,
    authMethod: cfg.authMethod,
    privateKeyPath: cfg.privateKeyPath,
    workingDir: cfg.workingDir || session.projectPath || '~',
    command: '',
    ...(cfg.autoConfirmTrust === false ? { autoConfirmTrust: false as const } : {}),
  };
}
