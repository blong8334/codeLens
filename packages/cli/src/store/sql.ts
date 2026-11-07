// The store, written once in portable SQL (upserts, RETURNING, IN lists) and run on any SqlDriver.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DescriptionKind, SnapshotRecord, Store } from './index.ts';

export type Row = Record<string, unknown>;

/** The few operations the store needs from a database. SQL uses `?` placeholders throughout. */
export interface SqlDriver {
  dialect: 'sqlite' | 'postgres';
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  /** The same statement for many parameter rows, atomically. */
  runMany(sql: string, rows: unknown[][]): Promise<void>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** Rows per IN list or multi-row write: well under both databases' parameter limits. */
const CHUNK = 400;
const SNAPSHOTS_KEPT = 5;

export class SqlStore implements Store {
  private constructor(
    private db: SqlDriver,
    private schema: string | undefined,
    readonly location: string,
  ) {}

  static async open(db: SqlDriver, opts: { schema?: string; location: string }): Promise<SqlStore> {
    const store = new SqlStore(db, db.dialect === 'postgres' ? (opts.schema ?? 'codelens') : undefined, opts.location);
    await store.migrate();
    return store;
  }

  /** Table name, schema-qualified on Postgres. */
  private t(name: string) {
    return this.schema ? `"${this.schema}".${name}` : name;
  }

  private async migrate() {
    const pg = this.db.dialect === 'postgres';
    if (pg) await this.db.exec(`create schema if not exists "${this.schema}"`);
    const id = pg ? 'bigint generated always as identity primary key' : 'integer primary key';
    const noRowid = pg ? '' : ' without rowid';
    await this.db.exec(`
create table if not exists ${this.t('meta')} (key text primary key, value text);
create table if not exists ${this.t('parses')} (blob text not null, extractor text not null, data text not null, primary key (blob, extractor))${noRowid};
create table if not exists ${this.t('descriptions')} (key text primary key, kind text not null, value text not null, created_at text not null)${noRowid};
create table if not exists ${this.t('snapshots')} (
  id ${id}, repo text not null, scope text not null, commit_sha text, dirty integer not null,
  tree text not null, created_at text not null, provider text not null, files integer not null, functions integer not null
);
create index if not exists snapshots_by_repo on ${this.t('snapshots')} (repo, scope, id);
create table if not exists ${this.t('review_marks')} (review text not null, reviewer text not null, path text not null, fingerprint text not null, marked_at text not null, primary key (review, reviewer, path))${noRowid};
create table if not exists ${this.t('snapshot_fns')} (snapshot bigint not null, fn text not null, fingerprint text not null, primary key (snapshot, fn))${noRowid};
`);
    if (this.location !== ':memory:' && !pg) await this.migrateJsonCaches(dirname(this.location));
  }

  // ---- parses ----

  async getParses(extractor: string, blobs: string[]) {
    const out = new Map<string, string>();
    for (const part of chunks(blobs)) {
      const rows = await this.db.all(`select blob, data from ${this.t('parses')} where extractor = ? and blob in (${marks(part)})`, [extractor, ...part]);
      for (const r of rows) out.set(String(r.blob), String(r.data));
    }
    return out;
  }

  async putParses(extractor: string, rows: { blob: string; data: string }[]) {
    if (!rows.length) return;
    await this.db.runMany(
      `insert into ${this.t('parses')} (blob, extractor, data) values (?, ?, ?) on conflict (blob, extractor) do update set data = excluded.data`,
      unique(rows, (r) => r.blob).map((r) => [r.blob, extractor, r.data]),
    );
  }

  // ---- descriptions ----

  async getDescriptions(keys: string[]) {
    const out = new Map<string, unknown>();
    for (const part of chunks([...new Set(keys)])) {
      const rows = await this.db.all(`select key, value from ${this.t('descriptions')} where key in (${marks(part)})`, part);
      for (const r of rows) out.set(String(r.key), JSON.parse(String(r.value)));
    }
    return out;
  }

  async putDescriptions(rows: { key: string; kind: DescriptionKind; value: unknown }[]) {
    if (!rows.length) return;
    const now = new Date().toISOString();
    await this.db.runMany(
      `insert into ${this.t('descriptions')} (key, kind, value, created_at) values (?, ?, ?, ?) on conflict (key) do update set kind = excluded.kind, value = excluded.value, created_at = excluded.created_at`,
      unique(rows, (r) => r.key).map((r) => [r.key, r.kind, JSON.stringify(r.value), now]),
    );
  }

  // ---- snapshots ----

  async lastSnapshot(repo: string, scope: string) {
    const [row] = await this.db.all(`select * from ${this.t('snapshots')} where repo = ? and scope = ? order by id desc limit 1`, [repo, scope]);
    return row ? toRecord(row) : undefined;
  }

  async snapshotFunctions(id: number) {
    const rows = await this.db.all(`select fn, fingerprint from ${this.t('snapshot_fns')} where snapshot = ?`, [id]);
    return new Map(rows.map((r) => [String(r.fn), String(r.fingerprint)]));
  }

  async recordSnapshot(rec: Omit<SnapshotRecord, 'id' | 'createdAt'>, fns: Iterable<[string, string]>) {
    const createdAt = new Date().toISOString();
    const [row] = await this.db.all(
      `insert into ${this.t('snapshots')} (repo, scope, commit_sha, dirty, tree, created_at, provider, files, functions) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [rec.repo, rec.scope, rec.commit, rec.dirty ? 1 : 0, rec.tree, createdAt, rec.provider, rec.files, rec.functions],
    );
    const id = Number(row.id);
    await this.db.runMany(`insert into ${this.t('snapshot_fns')} (snapshot, fn, fingerprint) values (?, ?, ?) on conflict (snapshot, fn) do nothing`, unique([...fns], ([fn]) => fn).map(([fn, fp]) => [id, fn, fp]));
    // Only the latest few snapshots per scope are needed to answer "what changed since".
    const all = this.db.dialect === 'postgres' ? 'limit all' : 'limit -1';
    const stale = await this.db.all(`select id from ${this.t('snapshots')} where repo = ? and scope = ? order by id desc ${all} offset ${SNAPSHOTS_KEPT}`, [rec.repo, rec.scope]);
    for (const part of chunks(stale.map((r) => Number(r.id)))) {
      await this.db.run(`delete from ${this.t('snapshot_fns')} where snapshot in (${marks(part)})`, part);
      await this.db.run(`delete from ${this.t('snapshots')} where id in (${marks(part)})`, part);
    }
    return { ...rec, id, createdAt };
  }

  // ---- review marks ----

  async getMarks(review: string, reviewer: string) {
    const rows = await this.db.all(`select path, fingerprint, marked_at from ${this.t('review_marks')} where review = ? and reviewer = ?`, [review, reviewer]);
    return new Map(rows.map((r) => [String(r.path), { fingerprint: String(r.fingerprint), markedAt: String(r.marked_at) }]));
  }

  async setMark(review: string, reviewer: string, path: string, fingerprint: string | null) {
    if (fingerprint === null) {
      await this.db.run(`delete from ${this.t('review_marks')} where review = ? and reviewer = ? and path = ?`, [review, reviewer, path]);
      return;
    }
    await this.db.run(
      `insert into ${this.t('review_marks')} (review, reviewer, path, fingerprint, marked_at) values (?, ?, ?, ?, ?) on conflict (review, reviewer, path) do update set fingerprint = excluded.fingerprint, marked_at = excluded.marked_at`,
      [review, reviewer, path, fingerprint, new Date().toISOString()],
    );
  }

  async clearMarks(review: string, reviewer: string) {
    await this.db.run(`delete from ${this.t('review_marks')} where review = ? and reviewer = ?`, [review, reviewer]);
  }

  async listSnapshots(repo?: string) {
    const rows = repo
      ? await this.db.all(`select * from ${this.t('snapshots')} where repo = ? order by id desc`, [repo])
      : await this.db.all(`select * from ${this.t('snapshots')} order by id desc`);
    return rows.map(toRecord);
  }

  async stats() {
    const count = async (t: string) => Number((await this.db.all(`select count(*) as n from ${this.t(t)}`))[0].n);
    return { parses: await count('parses'), descriptions: await count('descriptions'), snapshots: await count('snapshots') };
  }

  close() {
    return this.db.close();
  }

  /** Import the JSON description caches older CodeLens versions wrote next to the store. */
  private async migrateJsonCaches(dir: string) {
    if ((await this.db.all(`select value from ${this.t('meta')} where key = 'json-migrated'`)).length) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => /^[0-9a-f]{16}\.json$/.test(n));
    } catch {
      // No cache directory yet.
    }
    const rows: { key: string; kind: DescriptionKind; value: unknown }[] = [];
    for (const name of names) {
      try {
        const c = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { fns?: Record<string, unknown>; groups?: Record<string, unknown> };
        for (const [key, value] of Object.entries(c.fns ?? {})) rows.push({ key, kind: 'fn', value });
        for (const [key, value] of Object.entries(c.groups ?? {})) rows.push({ key, kind: 'group', value });
      } catch {
        // Unreadable legacy cache: skip it.
      }
    }
    await this.putDescriptions(rows);
    await this.db.run(`insert into ${this.t('meta')} (key, value) values ('json-migrated', ?) on conflict (key) do update set value = excluded.value`, [new Date().toISOString()]);
  }
}

/** Last write wins per key: a multi-row upsert may not touch the same row twice. */
function unique<T>(rows: T[], key: (r: T) => string): T[] {
  return [...new Map(rows.map((r) => [key(r), r])).values()];
}

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const marks = (items: unknown[]) => items.map(() => '?').join(', ');

function toRecord(r: Row): SnapshotRecord {
  return {
    id: Number(r.id),
    repo: String(r.repo),
    scope: String(r.scope),
    commit: (r.commit_sha as string | null) ?? null,
    dirty: !!Number(r.dirty),
    tree: String(r.tree),
    createdAt: String(r.created_at),
    provider: String(r.provider),
    files: Number(r.files),
    functions: Number(r.functions),
  };
}
