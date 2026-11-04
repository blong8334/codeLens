// SQLite through Node's built-in driver: a single local file, no setup.
import { mkdirSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { dirname } from 'node:path';
import type { SqlDriver } from './sql.ts';

type Param = null | number | bigint | string;

export function sqliteDriver(path: string): SqlDriver {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma synchronous = normal;');
  const cache = new Map<string, StatementSync>();
  const q = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    dialect: 'sqlite',
    all: async (sql, params = []) => q(sql).all(...(params as Param[])) as Record<string, unknown>[],
    run: async (sql, params = []) => {
      q(sql).run(...(params as Param[]));
    },
    // Synchronous inside, so concurrent async callers can never interleave transactions.
    runMany: async (sql, rows) => {
      if (!rows.length) return;
      const s = q(sql);
      db.exec('begin');
      try {
        for (const r of rows) s.run(...(r as Param[]));
        db.exec('commit');
      } catch (err) {
        db.exec('rollback');
        throw err;
      }
    },
    exec: async (sql) => db.exec(sql),
    close: async () => db.close(),
  };
}
