import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let root: string;
let dbPath: string;
const tables = ['resource_transfer_state', 'project_sync_links', 'project_sync_base', 'project_sync_runs', 'project_sync_entries'];
const transferBody = ' {"devices":[{"home":"/private/old/home"}],"tasks":[{"id":"one","state":"running"},{"id":"two"}],"locations":{}} ';
function seed() {
  mkdirSync(join(root, 'data'));
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE resource_transfer_state (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE project_sync_links (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE project_sync_base (link_id TEXT, path TEXT, body TEXT, PRIMARY KEY(link_id,path));
    CREATE TABLE project_sync_runs (id TEXT PRIMARY KEY, link_id TEXT, created_at INTEGER, body TEXT);
    CREATE TABLE project_sync_entries (run_id TEXT, entry_id TEXT, body TEXT, PRIMARY KEY(run_id,entry_id));`);
  db.prepare('INSERT INTO resource_transfer_state VALUES (1,?)').run(transferBody);
  db.prepare('INSERT INTO project_sync_links VALUES (?,?)').run('link', '{"localRoot":"/private/project","remoteRoot":"/private/device"}');
  db.prepare('INSERT INTO project_sync_base VALUES (?,?,?)').run('link', 'secret.env', ' raw malformed legacy metadata \n');
  db.prepare('INSERT INTO project_sync_runs VALUES (?,?,?,?)').run('run', 'link', 7, '{"state":"running"}');
  db.prepare('INSERT INTO project_sync_entries VALUES (?,?,?)').run('run', 'entry', '{"backupPath":"/private/journal/backup","mode":384}');
  db.close();
}
function rows() {
  const db = new Database(dbPath, { readonly: true });
  const result = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  db.close();
  return result;
}
const destination = () => join(root, 'data', 'legacy-resource-tools', '2026-10-10T01-02-03.json');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aasc-retired-history-'));
  dbPath = join(root, 'data', 'sessions.db');
  vi.stubEnv('APP_USER_DATA', root);
  vi.resetModules();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('inert legacy history', () => {
  it('legacy_export_preserves_row_counts and exact raw bodies without database writes', async () => {
    seed();
    const before = rows(), bytes = readFileSync(dbPath);
    const { exportLegacyResourceHistory } = await import('../server/cloud/legacyHistory.js');
    const result = await exportLegacyResourceHistory(destination());
    expect(result).toEqual({ path: destination(), transferTasks: 2, projectLinks: 1, projectRuns: 1 });
    const output = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(output.format).toBe('aasc-legacy-resources-v1');
    expect(output.transfers).toEqual(before.resource_transfer_state);
    expect(output.projectSync).toEqual({ links: before.project_sync_links, base: before.project_sync_base, runs: before.project_sync_runs, entries: before.project_sync_entries });
    expect(rows()).toEqual(before);
    expect(readFileSync(dbPath)).toEqual(bytes);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root,'data','legacy-resource-tools')).mode & 0o777).toBe(0o700);
    await expect(exportLegacyResourceHistory(destination())).rejects.toThrow(); // Never overwrite recovery material.
  });

  it('legacy_tables_are_not_dropped or normalized during current database startup', async () => {
    seed(); const before = rows();
    const current = await import('../server/db.js');
    current.closeDb();
    expect(rows()).toEqual(before);
  });

  it('fresh database startup creates no legacy tables', async () => {
    const current = await import('../server/db.js'); current.closeDb();
    const db = new Database(dbPath, {readonly:true});
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => (row as {name:string}).name).filter(name => tables.includes(name))).toEqual([]);
    db.close();
  });

  it('missing database exports empty history without creating a database', async () => {
    const { exportLegacyResourceHistory } = await import('../server/cloud/legacyHistory.js');
    const output = await exportLegacyResourceHistory(destination());
    expect(output).toMatchObject({transferTasks:0,projectLinks:0,projectRuns:0});
    const body = JSON.parse(readFileSync(output.path,'utf8'));
    expect(body).toMatchObject({transfers:null,projectSync:{links:[],base:[],runs:[],entries:[]}});
    expect(() => statSync(dbPath)).toThrow();
  });

  it('absent tables are empty and raw malformed history is retained', async () => {
    mkdirSync(join(root,'data')); const db=new Database(dbPath);
    db.exec('CREATE TABLE resource_transfer_state (id INTEGER PRIMARY KEY, body TEXT)');
    db.prepare('INSERT INTO resource_transfer_state VALUES(1,?)').run(' unreadable state '); db.close();
    const { exportLegacyResourceHistory } = await import('../server/cloud/legacyHistory.js');
    const result=await exportLegacyResourceHistory(destination());
    expect(JSON.parse(readFileSync(result.path,'utf8'))).toMatchObject({transfers:[{id:1,body:' unreadable state '}],projectSync:{links:[],base:[],runs:[],entries:[]}});
    expect(result.transferTasks).toBe(0);
  });

  it('export refuses outside paths and linked destination folders', async () => {
    seed(); const { exportLegacyResourceHistory } = await import('../server/cloud/legacyHistory.js');
    await expect(exportLegacyResourceHistory(join(root,'leak.json'))).rejects.toThrow();
    symlinkSync(root,join(root,'data','legacy-resource-tools'));
    await expect(exportLegacyResourceHistory(destination())).rejects.toThrow();
  });
});
