// The CodeLens store: everything learned about code, keyed by content.
//   • parses       — extracted functions per file content (git blob id), per extractor version
//   • descriptions — "what / why" text, group summaries and guides, per content hash and model
//   • snapshots    — which commit of which repo/scope was explored, with each function's
//                    fingerprint, so the next run can say what is new or changed.
// One SQL implementation runs on two drivers: SQLite (a local file, the default) and Postgres
// (shared by a team; each store lives in its own schema, which is also the unit of isolation).
// The API is asynchronous and batch-oriented so a remote database costs a few round trips per
// run, not one per file or function.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SqlStore } from './sql.ts';

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

export type DescriptionKind = 'fn' | 'group' | 'guide';

export interface Store {
  /** Where the data lives, for messages (a file path or a redacted database URL). */
  readonly location: string;
  /** Cached parses for these blobs, as stored JSON, keyed by blob id. */
  getParses(extractor: string, blobs: string[]): Promise<Map<string, string>>;
  putParses(extractor: string, rows: { blob: string; data: string }[]): Promise<void>;
  getDescriptions(keys: string[]): Promise<Map<string, unknown>>;
  putDescriptions(rows: { key: string; kind: DescriptionKind; value: unknown }[]): Promise<void>;
  lastSnapshot(repo: string, scope: string): Promise<SnapshotRecord | undefined>;
  snapshotFunctions(id: number): Promise<Map<string, string>>;
  recordSnapshot(rec: Omit<SnapshotRecord, 'id' | 'createdAt'>, fns: Iterable<[string, string]>): Promise<SnapshotRecord>;
  listSnapshots(repo?: string): Promise<SnapshotRecord[]>;
  stats(): Promise<{ parses: number; descriptions: number; snapshots: number }>;
  close(): Promise<void>;
}

export function cacheDir(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'codelens');
}

export function defaultStorePath(): string {
  return process.env.CODELENS_STORE ?? join(cacheDir(), 'store.db');
}

const isPostgresUrl = (s: string) => /^postgres(ql)?:\/\//.test(s);

/**
 * Open a store from a location: a SQLite file path (or `:memory:`), or a Postgres URL such as
 * `postgres://user:pass@host/db?schema=team_a`. The schema defaults to `codelens`.
 */
export async function openStore(location: string = defaultStorePath()): Promise<Store> {
  if (isPostgresUrl(location)) {
    const { postgresDriver } = await import('./postgres.ts');
    const { driver, schema, redacted } = await postgresDriver(location);
    return SqlStore.open(driver, { schema, location: redacted });
  }
  const { sqliteDriver } = await import('./sqlite.ts');
  return SqlStore.open(sqliteDriver(location), { location });
}

export { SqlStore } from './sql.ts';
export type { SqlDriver } from './sql.ts';
