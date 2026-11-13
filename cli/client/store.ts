/**
 * What `aasc` keeps on disk (terminal editions plan §9.2):
 *
 *   ~/.config/aasc/            0700 · $XDG_CONFIG_HOME honoured · the same path on macOS
 *   ├── servers.json           0600  the servers, never a key
 *   ├── keys/<id>.key          0600  the device key from pairing
 *   └── last-ls.json           0600  number → session id, for `aasc attach 2`
 *
 * The desktop keeps its device keys in the keychain (safeStorage). A terminal tool can't,
 * so these are 0600 files in a 0700 folder, the way ssh and gh keep theirs. Every write is
 * write-to-temp + rename, and every read goes through a Zod schema: a file that fails it is
 * an error, never a guess.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { z } from 'zod';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SERVER_ID = /^[0-9a-f]{32}$/;

/** A server's short name: what `vps:2` and `aasc ls vps` use. No ':' so `name:ref` stays unambiguous. */
export function isValidServerName(name: string): boolean {
  return SERVER_NAME.test(name);
}

const AddressesSchema = z.object({
  lan: z.string().max(64).nullable(),
  tailnet: z.string().max(64).nullable(),
  /** Present only when the server was added with --insecure: plain HTTP over the Internet. */
  public: z.string().max(64).nullable(),
});

const ServerSchema = z.object({
  name: z.string().regex(SERVER_NAME),
  id: z.string().regex(SERVER_ID),
  mode: z.enum(['paired', 'ssh']),
  /** Paired: the remote's device list entry. Not secret (it travels in every challenge). */
  deviceId: z.string().max(64).optional(),
  addresses: AddressesSchema.optional(),
  port: z.number().int().min(1).max(65535),
  sshTarget: z.string().max(300).optional(),
  remoteDataDir: z.string().max(1024).optional(),
  clientId: z.string().regex(/^aasc-[0-9a-f-]{36}$/),
  pairedAt: z.string().max(64),
});

export type ServerRecord = z.infer<typeof ServerSchema>;
export type NewServer = Omit<ServerRecord, 'id' | 'clientId' | 'pairedAt'>;

const ServersFileSchema = z.array(ServerSchema);

const LastLsSchema = z.array(z.object({
  n: z.number().int().min(1),
  server: z.string().regex(SERVER_NAME),
  sessionId: z.string().min(1).max(256),
}));

export type LastLsEntry = z.infer<typeof LastLsSchema>[number];

/** `$XDG_CONFIG_HOME/aasc`, else `~/.config/aasc` (macOS too: a terminal tool, not an app). */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? xdg : join(env.HOME?.trim() || homedir(), '.config');
  return join(base, 'aasc');
}

export class StoreError extends Error {}

/**
 * Refuse a path that is a symlink, isn't the expected kind, or belongs to another user: a
 * planted folder or file could read the keys we write, or feed us servers we never added.
 * A missing path is fine (it's created next). `uid` is undefined where there are no uids (Windows).
 */
function checkOwned(path: string, kind: 'folder' | 'file', uid: number | undefined): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new StoreError(`${path} is a symlink. aasc keeps its keys only in a real ${kind} it owns; remove the link.`);
  }
  if (kind === 'folder' ? !st.isDirectory() : !st.isFile()) throw new StoreError(`${path} isn’t a ${kind}.`);
  if (uid !== undefined && st.uid !== uid) {
    throw new StoreError(`${path} is owned by another user. aasc won’t use it; remove it, or point XDG_CONFIG_HOME elsewhere.`);
  }
}

function ensureDir(dir: string, uid: number | undefined): void {
  checkOwned(dir, 'folder', uid);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  checkOwned(dir, 'folder', uid);
  // mkdir's mode is masked by the umask, and an existing folder keeps its old mode.
  chmodSync(dir, DIR_MODE);
}

/** Write-to-temp + rename, 0600 from the first byte. */
function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, contents, { mode: FILE_MODE });
    chmodSync(tmp, FILE_MODE);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new StoreError(`${file} isn’t valid JSON. Fix or delete it.`);
  }
}

export interface Store {
  dir: string;
  listServers(): ServerRecord[];
  getServer(name: string): ServerRecord | null;
  /** Adds a server; `deviceKey` (paired mode) goes to keys/<id>.key, never into servers.json. */
  addServer(input: NewServer, deviceKey?: string): ServerRecord;
  /** Replaces a stored server's fields (same id), e.g. a refreshed Tailscale address. */
  updateServer(record: ServerRecord): void;
  removeServer(name: string): boolean;
  readKey(id: string): string | null;
  writeLastLs(entries: LastLsEntry[]): void;
  readLastLs(): LastLsEntry[];
}

export interface StoreOptions {
  /** Whose files these must be; default this process's uid. A test seam. */
  uid?: number;
}

export function createStore(dir: string = configDir(), options: StoreOptions = {}): Store {
  const uid = options.uid ?? process.getuid?.();
  const serversFile = join(dir, 'servers.json');
  const keysDir = join(dir, 'keys');
  const lastLsFile = join(dir, 'last-ls.json');
  const keyFile = (id: string): string => {
    if (!SERVER_ID.test(id)) throw new StoreError('Invalid server id.');
    return join(keysDir, `${id}.key`);
  };

  /** Check the folder and `file` before reading `file`. */
  const checkRead = (file: string, ...folders: string[]): void => {
    for (const f of [dir, ...folders]) checkOwned(f, 'folder', uid);
    checkOwned(file, 'file', uid);
  };

  function listServers(): ServerRecord[] {
    checkRead(serversFile);
    const raw = readJson(serversFile);
    if (raw === null) return [];
    const parsed = ServersFileSchema.safeParse(raw);
    if (!parsed.success) throw new StoreError(`${serversFile} doesn’t look like aasc’s servers.json. Fix or delete it.`);
    return parsed.data;
  }

  function writeServers(list: ServerRecord[]): void {
    ensureDir(dir, uid);
    writeAtomic(serversFile, `${JSON.stringify(list, null, 2)}\n`);
  }

  return {
    dir,
    listServers,
    getServer(name) {
      return listServers().find((s) => s.name === name) ?? null;
    },
    addServer(input, deviceKey) {
      if (!isValidServerName(input.name)) {
        throw new StoreError(`"${input.name}" isn’t a usable name: 1–32 letters, digits, - or _, starting with a letter or digit.`);
      }
      const list = listServers();
      if (list.some((s) => s.name === input.name)) {
        throw new StoreError(`A server called "${input.name}" is already added. Pick another with --name, or aasc remove ${input.name}.`);
      }
      const record = ServerSchema.parse({
        ...input,
        id: randomBytes(16).toString('hex'),
        clientId: `aasc-${randomUUID()}`,
        pairedAt: new Date().toISOString(),
      });
      if (deviceKey !== undefined) {
        ensureDir(dir, uid);
        ensureDir(keysDir, uid);
        writeAtomic(keyFile(record.id), `${deviceKey}\n`);
      }
      writeServers([...list, record]);
      return record;
    },
    updateServer(record) {
      const valid = ServerSchema.parse(record);
      const list = listServers();
      if (!list.some((s) => s.id === valid.id)) throw new StoreError(`No server with id ${valid.id}.`);
      writeServers(list.map((s) => (s.id === valid.id ? valid : s)));
    },
    removeServer(name) {
      const list = listServers();
      const target = list.find((s) => s.name === name);
      if (!target) return false;
      writeServers(list.filter((s) => s.id !== target.id));
      rmSync(keyFile(target.id), { force: true });
      return true;
    },
    readKey(id) {
      const file = keyFile(id);
      checkRead(file, keysDir);
      if (!existsSync(file)) return null;
      // Like ssh with a private key: refuse a key file anyone else can read.
      if ((statSync(file).mode & 0o077) !== 0) {
        throw new StoreError(`${file} is readable by other users. Run chmod 0600 on it, or remove and re-add the server.`);
      }
      const key = readFileSync(file, 'utf8').trim();
      return key || null;
    },
    writeLastLs(entries) {
      ensureDir(dir, uid);
      writeAtomic(lastLsFile, `${JSON.stringify(LastLsSchema.parse(entries))}\n`);
    },
    readLastLs() {
      checkRead(lastLsFile);
      const raw = readJson(lastLsFile);
      const parsed = LastLsSchema.safeParse(raw ?? []);
      return parsed.success ? parsed.data : [];
    },
  };
}
