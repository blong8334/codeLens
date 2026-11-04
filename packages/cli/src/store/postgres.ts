// Postgres, for a store shared by a team (or, hosted, one schema per customer).
import type { SqlDriver } from './sql.ts';

const ROWS_PER_INSERT = 400;

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Connect to `postgres://…[?schema=name]` with the `pg` driver. */
export async function postgresDriver(url: string): Promise<{ driver: SqlDriver; schema: string; redacted: string }> {
  const u = new URL(url);
  const schema = u.searchParams.get('schema') ?? 'codelens';
  if (!/^[A-Za-z_]\w{0,62}$/.test(schema)) throw new Error(`invalid Postgres schema name "${schema}"`);
  u.searchParams.delete('schema');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  // Fail fast with a clear message rather than on the first query.
  await pool.query('select 1').catch((err: Error) => {
    void pool.end();
    throw new Error(`cannot connect to Postgres at ${redact(u)}: ${err.message}`);
  });
  return { driver: pgDriver(pool, (sql) => pool.query(sql).then(() => undefined), () => pool.end()), schema, redacted: `${redact(u)} (schema ${schema})` };
}

/** A SqlDriver over anything with pg's `query(sql, params)` — the `pg` Pool, or PGlite in tests. */
export function pgDriver(db: Queryable, exec: (sql: string) => Promise<void>, close: () => Promise<void>): SqlDriver {
  return {
    dialect: 'postgres',
    all: async (sql, params = []) => (await db.query(numbered(sql), params)).rows,
    run: async (sql, params = []) => {
      await db.query(numbered(sql), params);
    },
    // One multi-row INSERT per chunk: a single round trip, atomic per statement.
    runMany: async (sql, rows) => {
      const m = sql.match(/values\s*\(([^)]*)\)/i);
      if (!m) throw new Error('runMany expects an INSERT … VALUES (…) statement');
      const width = (m[1].match(/\?/g) ?? []).length;
      for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
        const part = rows.slice(i, i + ROWS_PER_INSERT);
        const groups = part.map((_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(', ')})`).join(', ');
        await db.query(sql.replace(m[0], `values ${groups}`), part.flat());
      }
    },
    exec,
    close,
  };
}

/** `?` placeholders → `$1, $2, …` (the store's SQL never puts `?` inside literals). */
function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function redact(u: URL): string {
  const copy = new URL(u.toString());
  if (copy.password) copy.password = '***';
  return copy.toString();
}
