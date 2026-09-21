import type { Pool } from "pg";
import { streamRows } from "service-runtime";
import {
  type AnchorableRecord,
  type RecordRow,
  toAnchorableRecord,
} from "./record.ts";

const UNANCHORED_QUERY = `
  SELECT
      r.id,
      r.entity_id,
      r.record_type,
      r.payload,
      r.version,
      r.is_deleted,
      r.replaces,
      r.client_address,
      r.signature,
      r.created_at
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
 * Streams unanchored records in ascending ID order, yielding one at a time
 * to avoid loading the entire result set into memory.
 */
export async function* streamUnanchoredRecords(
  pool: Pool,
  batchSize = 10_000,
): AsyncGenerator<AnchorableRecord> {
  for await (const row of streamRows<RecordRow>(
    pool,
    UNANCHORED_QUERY,
    [],
    batchSize,
  )) {
    yield toAnchorableRecord(row);
  }
}
