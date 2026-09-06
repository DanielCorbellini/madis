/**
 * data-domain keeps its own pool factory rather than sharing packages/service-runtime
 * with the daemons: it's a request/response API with a different connection profile
 * (larger pool, no streaming/COPY workload), and it logs through Fastify, not pino.
 */
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
