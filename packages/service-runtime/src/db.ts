import { Pool, type PoolConfig } from "pg";

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Postgres pool tuned for the background daemons: a small connection ceiling
 * (one client for a streamed scan, one for a transaction)
 */
export function createDbPool(
  connectionString: string,
  options: Partial<PoolConfig> = {},
): Pool {
  return new Pool({ connectionString, max: 4, ...options });
}

export async function checkDatabaseConnection(pool: Queryable): Promise<void> {
  await pool.query("SELECT 1");
}
