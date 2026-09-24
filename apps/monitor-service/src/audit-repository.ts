import type { Pool } from "pg";
import {
  type AnchorableRecord,
  type Queryable,
  type RecordRow,
  streamRows,
  toAnchorableRecord,
} from "service-runtime";

/**
 * Ground-truth-agnostic count of how many `anchor_records` rows a batch
 * currently has. Compared against the batch's on-chain size (never
 * Postgres's own `batches.size`) to catch a deleted pinning row.
 */
export async function countAnchoredRecords(
  db: Queryable,
  batchId: number,
): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*) AS count FROM anchor_records WHERE batch_id = $1`,
    [batchId],
  );
  return Number((rows[0] as { count: string }).count);
}

export interface AnchoredRecordEntry {
  record: AnchorableRecord;
  proof: string[];
}

interface AnchoredRecordRow extends RecordRow {
  merkle_proof: string[];
}

const ANCHORED_RECORDS_QUERY = `
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
      r.created_at,
      ar.merkle_proof
  FROM
      anchor_records ar
      JOIN records r ON r.id = ar.record_id
  WHERE
      ar.batch_id = $1
  ORDER BY
      r.id ASC
`;

/**
 * Streams a batch's currently-existing `anchor_records` rows, each paired
 * with the raw `records` columns needed to recompute its leaf. A row whose
 * `anchor_records` entry was deleted never appears here — that gap is
 * `countAnchoredRecords`'s job, not this function's.
 */
export async function* streamAnchoredRecords(
  pool: Pool,
  batchId: number,
  batchSize = 10_000,
): AsyncGenerator<AnchoredRecordEntry> {
  for await (const row of streamRows<AnchoredRecordRow>(
    pool,
    ANCHORED_RECORDS_QUERY,
    [batchId],
    batchSize,
  )) {
    const { merkle_proof, ...recordRow } = row;
    yield { record: toAnchorableRecord(recordRow), proof: merkle_proof };
  }
}
