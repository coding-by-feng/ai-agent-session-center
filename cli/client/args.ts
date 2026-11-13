/** `aasc`'s argument parsing: positionals plus a fixed set of flags; anything else is a usage error. */
import { CliError, EXIT } from './exitCodes.js';

const VALUE_FLAGS = new Set(['name', 'ssh', 'port', 'remote-data-dir']);
const BOOL_FLAGS = new Set(['json', 'force', 'insecure', 'notify', 'help', 'version']);

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  let i = 0;
  let rest = false;
  while (i < argv.length) {
    const arg = argv[i++];
    if (rest || !arg.startsWith('--') || arg === '-') {
      if (arg === '-h') { flags.help = true; continue; }
      positionals.push(arg);
      continue;
    }
    if (arg === '--') { rest = true; continue; }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq > 0 ? eq : undefined);
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[i++];
      if (value === undefined || value === '') throw new CliError(EXIT.USAGE, `--${name} needs a value.`);
      flags[name] = value;
    } else if (BOOL_FLAGS.has(name) && eq < 0) {
      flags[name] = true;
    } else {
      throw new CliError(EXIT.USAGE, `Unknown option ${arg.slice(0, 40)}. Run aasc --help.`);
    }
  }
  const [command = null, ...others] = positionals;
  return { command, positionals: others, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!/^\d{1,5}$/.test(raw) || n < 1 || n > 65535) throw new CliError(EXIT.USAGE, `--port must be 1–65535.`);
  return n;
}
