import pg from 'pg';
import { config } from './config';

// Return DATE columns as 'YYYY-MM-DD' strings instead of JS Dates (avoids timezone shifts).
pg.types.setTypeParser(1082, (value) => value);

export const pool = new pg.Pool(config.db);

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

export async function rows<T>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}

export async function one<T>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await rows<T>(db, sql, params))[0];
}

/** Runs `fn` in a transaction: everything is saved, or nothing is. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Creates the database (e.g. "zeroproxy") if it does not exist yet. */
export async function ensureDatabase() {
  const admin = new pg.Client({ ...config.db, database: 'postgres' });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.db.database]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${config.db.database.replace(/"/g, '')}"`);
      console.log(`Created database "${config.db.database}"`);
    }
  } finally {
    await admin.end();
  }
}
