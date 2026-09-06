import type { Pool } from "pg";
import QueryStream from "pg-query-stream";

export interface UnanchoredRecord {
  id: number;
  payload: Record<string, unknown>;
  signature: string;
  clientAddress: string;
}

interface UnanchoredRow {
  id: string;
  payload: Record<string, unknown>;
  signature: string;
  client_address: string;
}

const UNANCHORED_QUERY = `
  SELECT
      r.id,
      r.payload,
      r.signature,
      r.client_address
  FROM
      records r
  WHERE
      NOT EXISTS (
          SELECT
              1
          FROM
              anchor_records ar
          WHERE
              ar.record_id = r.id
      )
  ORDER BY
      r.id ASC
`;

/**
 * Streams unanchored records in ascending ID order, yielding one record at a time
 * to avoid loading the entire result set into memory.
 */
export async function* streamUnanchoredRecords(
  pool: Pool,
  batchSize = 10_000,
): AsyncGenerator<UnanchoredRecord> {
  const client = await pool.connect();
  try {
    const stream = client.query(
      new QueryStream(UNANCHORED_QUERY, [], { batchSize }),
    );

    for await (const row of stream as AsyncIterable<UnanchoredRow>) {
      yield {
        id: Number(row.id),
        payload: row.payload,
        signature: row.signature,
        clientAddress: row.client_address,
      };
    }
  } finally {
    client.release();
  }
}
