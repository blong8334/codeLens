// The CodeLens store: one SQLite database (Node's built-in driver) that remembers
//   • parses       — extracted functions per file content (git blob id), per extractor version
//   • descriptions — "what / why" text per function or group content hash, per model
//   • snapshots    — which commit of which repo/scope was explored, and the functions it had,
//                    so the next run knows what is new or changed since you last looked.
// Everything is keyed by content, so switching branches or re-exploring only pays for new code.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface SnapshotRecord {
  id: number;
  repo: string;
  scope: string;
  commit: string | null;
  dirty: boolean;
  /** Hash over (path, blob) of every source file in scope: equal trees mean nothing changed. */
  tree: string;
  createdAt: string;
  provider: string;
  files: number;
  functions: number;
}

export function cacheDir(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'codelens');
}

export function defaultStorePath(): string {
  return process.env.CODELENS_STORE ?? join(cacheDir(), 'store.db');
}

const SCHEMA = `
pragma journal_mode = wal;
pragma synchronous = normal;
create table if not exists meta (key text primary key, value text);
create table if not exists parses (
  blob text not null, extractor text not null, data text not null,
  primary key (blob, extractor)
) without rowid;
create table if not exists descriptions (
  key text primary key, kind text not null, value text not null, created_at text not null
) without rowid;
create table if not exists snapshots (
  id integer primary key, repo text not null, scope text not null, commit_sha text, dirty integer not null,
  tree text not null, created_at text not null, provider text not null, files integer not null, functions integer not null
);
create index if not exists snapshots_by_repo on snapshots (repo, scope, id);
create table if not exists snapshot_fns (
  snapshot integer not null references snapshots(id) on delete cascade, fn text not null, fingerprint text not null,
  primary key (snapshot, fn)
) without rowid;
`;

export class Store {
  private db: DatabaseSync;
  private stmts = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private inTx = 0;

  constructor(readonly path: string = defaultStorePath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.db.exec('pragma foreign_keys = on');
    if (path !== ':memory:') this.migrateJsonCaches(dirname(path));
  }

  private q(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Explicit transaction bounds, for batching writes across async work. */
  begin() {
    if (!this.inTx++) this.db.exec('begin');
  }

  commit() {
    if (this.inTx && !--this.inTx) this.db.exec('commit');
  }

  /** Run `fn` in one transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): T {
    if (this.inTx++) {
      try {
        return fn();
      } finally {
        this.inTx--;
      }
    }
    this.db.exec('begin');
    try {
      const out = fn();
      this.db.exec('commit');
      return out;
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    } finally {
      this.inTx--;
    }
  }

  // ---- parses ----

  getParse(blob: string, extractor: string): string | undefined {
    return (this.q('select data from parses where blob = ? and extractor = ?').get(blob, extractor) as { data: string } | undefined)?.data;
  }

  putParse(blob: string, extractor: string, data: string) {
    this.q('insert or replace into parses (blob, extractor, data) values (?, ?, ?)').run(blob, extractor, data);
  }

  // ---- descriptions ----

  getDescription<T>(key: string): T | undefined {
    const row = this.q('select value from descriptions where key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  putDescription(key: string, kind: 'fn' | 'group', value: unknown) {
    this.q('insert or replace into descriptions (key, kind, value, created_at) values (?, ?, ?, ?)').run(key, kind, JSON.stringify(value), new Date().toISOString());
  }

  // ---- snapshots ----

  lastSnapshot(repo: string, scope: string): SnapshotRecord | undefined {
    const row = this.q('select * from snapshots where repo = ? and scope = ? order by id desc limit 1').get(repo, scope);
    return row ? toRecord(row as Row) : undefined;
  }

  snapshotFunctions(id: number): Map<string, string> {
    const rows = this.q('select fn, fingerprint from snapshot_fns where snapshot = ?').all(id) as { fn: string; fingerprint: string }[];
    return new Map(rows.map((r) => [r.fn, r.fingerprint]));
  }

  recordSnapshot(rec: Omit<SnapshotRecord, 'id' | 'createdAt'>, fns: Iterable<[string, string]>): SnapshotRecord {
    return this.transaction(() => {
      const createdAt = new Date().toISOString();
      const { lastInsertRowid } = this.q(
        'insert into snapshots (repo, scope, commit_sha, dirty, tree, created_at, provider, files, functions) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(rec.repo, rec.scope, rec.commit, rec.dirty ? 1 : 0, rec.tree, createdAt, rec.provider, rec.files, rec.functions);
      const id = Number(lastInsertRowid);
      const ins = this.q('insert or replace into snapshot_fns (snapshot, fn, fingerprint) values (?, ?, ?)');
      for (const [fn, fp] of fns) ins.run(id, fn, fp);
      // Only the latest few snapshots per scope are needed to answer "what changed since".
      this.q('delete from snapshots where repo = ? and scope = ? and id not in (select id from snapshots where repo = ? and scope = ? order by id desc limit 5)').run(
        rec.repo,
        rec.scope,
        rec.repo,
        rec.scope,
      );
      return { ...rec, id, createdAt };
    });
  }

  listSnapshots(repo?: string): SnapshotRecord[] {
    const rows = repo
      ? this.q('select * from snapshots where repo = ? order by id desc').all(repo)
      : this.q('select * from snapshots order by id desc').all();
    return (rows as Row[]).map(toRecord);
  }

  stats(): { parses: number; descriptions: number; snapshots: number } {
    const count = (t: string) => (this.q(`select count(*) as n from ${t}`).get() as { n: number }).n;
    return { parses: count('parses'), descriptions: count('descriptions'), snapshots: count('snapshots') };
  }

  /** Forget cached parses (they are cheap to rebuild); descriptions and snapshots stay. */
  pruneParses(keepExtractor: string) {
    this.q('delete from parses where extractor not like ?').run(`%:${keepExtractor}`);
  }

  close() {
    this.db.close();
  }

  /** Import the JSON description caches older CodeLens versions wrote next to the store. */
  private migrateJsonCaches(dir: string) {
    if (this.q("select value from meta where key = 'json-migrated'").get()) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => /^[0-9a-f]{16}\.json$/.test(n));
    } catch {
      // No cache directory yet.
    }
    this.transaction(() => {
      for (const name of names) {
        try {
          const c = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { fns?: Record<string, unknown>; groups?: Record<string, unknown> };
          for (const [k, v] of Object.entries(c.fns ?? {})) this.putDescription(k, 'fn', v);
          for (const [k, v] of Object.entries(c.groups ?? {})) this.putDescription(k, 'group', v);
        } catch {
          // Unreadable legacy cache: skip it.
        }
      }
      this.q("insert or replace into meta (key, value) values ('json-migrated', ?)").run(new Date().toISOString());
    });
  }
}

type Row = Record<string, string | number | null>;

function toRecord(r: Row): SnapshotRecord {
  return {
    id: Number(r.id),
    repo: String(r.repo),
    scope: String(r.scope),
    commit: (r.commit_sha as string | null) ?? null,
    dirty: !!r.dirty,
    tree: String(r.tree),
    createdAt: String(r.created_at),
    provider: String(r.provider),
    files: Number(r.files),
    functions: Number(r.functions),
  };
}
