import pg from 'pg';
import { readFile } from 'node:fs/promises';

export function createPool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000});
  pool.on('error', () => console.error('Idle database connection failed'));
  return pool;
}
export async function migrate(pool) {
  const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(70261117)');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}
