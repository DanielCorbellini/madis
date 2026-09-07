import type { Pool } from "pg";
import QueryStream from "pg-query-stream";

/**
 * Streams the rows of a parameterised query through a server-side cursor, so a
 * large result set never buffers in the client. Holds one pooled client for the
 * duration and releases it when iteration finishes — including when the consumer
 * breaks out early or throws.
 */
export async function* streamRows<T = Record<string, unknown>>(
  pool: Pool,
  sql: string,
  params: unknown[] = [],
  batchSize = 10_000,
): AsyncGenerator<T> {
  const client = await pool.connect();
  try {
    const stream = client.query(new QueryStream(sql, params, { batchSize }));
    yield* stream as AsyncIterable<T>;
  } finally {
    client.release();
  }
}
