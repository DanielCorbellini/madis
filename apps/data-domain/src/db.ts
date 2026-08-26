import { Pool, type PoolConfig } from "pg";

export function createDbPool(
  connectionString: string,
  options: Partial<PoolConfig> = {},
): Pool {
  return new Pool({ connectionString, ...options });
}

export async function checkDatabaseConnection(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}
