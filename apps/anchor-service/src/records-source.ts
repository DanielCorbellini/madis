import type { Pool } from "pg";
import {
  type AnchorableRecord,
  type RecordRow,
  streamRows,
  toAnchorableRecord,
} from "service-runtime";

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
      r.id > $1
      AND NOT EXISTS (
          SELECT
              1
          FROM
              anchor_records ar
          WHERE
              ar.record_id = r.id
      )
  ORDER BY
      r.id ASC
  LIMIT
      $2
`;

/**
 * Which slice of the un-anchored backlog to read: records with an id greater
 * than `afterId`, at most `limit` of them (`null` = no limit). A cycle walks
 * the backlog by moving `afterId` forward, one short query per batch, instead
 * of holding one cursor open across every batch's chain wait.
 */
export interface RecordWindow {
  afterId?: number;
  limit?: number | null;
}

/**
 * Streams the un-anchored records of `window` in ascending ID order, yielding
 * one at a time to avoid loading the entire result set into memory.
 */
export async function* streamUnanchoredRecords(
  pool: Pool,
  window: RecordWindow = {},
  fetchSize = 10_000,
): AsyncGenerator<AnchorableRecord> {
  for await (const row of streamRows<RecordRow>(
    pool,
    UNANCHORED_QUERY,
    [window.afterId ?? 0, window.limit ?? null],
    fetchSize,
  )) {
    yield toAnchorableRecord(row);
  }
}
