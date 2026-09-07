import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Pool } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import QueryStream from "pg-query-stream";
import type { Queryable } from "service-runtime";

export type BatchStatus = "pending" | "submitted" | "confirmed" | "failed";

export interface Batch {
  id: number;
  status: BatchStatus;
  merkleRoot: string;
  size: number;
  transactionHash: string | null;
  blockNumber: number | null;
  retryCount: number;
  errorMessage: string | null;
}

export interface AnchorEntry {
  recordId: number;
  proof: string[];
}

export interface BatchRecord {
  id: number;
  payload: Record<string, unknown>;
  signature: string;
  clientAddress: string;
}

interface BatchRowDb {
  id: string;
  status: BatchStatus;
  merkle_root: string;
  size: number;
  transaction_hash: string | null;
  block_number: string | null;
  retry_count: number;
  error_message: string | null;
}

interface BatchRecordRowDb {
  id: string;
  payload: Record<string, unknown>;
  signature: string;
  client_address: string;
}

function toBatch(row: BatchRowDb): Batch {
  return {
    id: Number(row.id),
    status: row.status,
    merkleRoot: row.merkle_root,
    size: row.size,
    transactionHash: row.transaction_hash,
    blockNumber: row.block_number === null ? null : Number(row.block_number),
    retryCount: row.retry_count,
    errorMessage: row.error_message,
  };
}

/**
 * Phase 4: pins a batch. Inserts the `pending` batch row and every
 * `anchor_records` row (via `COPY`) in one transaction, so membership is durable
 * before the on-chain transaction is attempted. Rolls back on any failure.
 */
export async function persistBatch(
  pool: Pool,
  batch: { root: string; entries: AnchorEntry[] },
): Promise<number> {
  if (batch.entries.length === 0) {
    throw new Error("cannot persist an empty batch");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `
        INSERT INTO
            batches (status, merkle_root, size)
        VALUES
            ('pending', $1, $2) RETURNING id
      `,
      [batch.root, batch.entries.length],
    );
    const batchId = Number(rows[0].id);

    const copyStream = client.query(
      copyFrom(
        "COPY anchor_records (record_id, batch_id, merkle_proof) FROM STDIN",
      ),
    );

    const lines = batch.entries.map(
      (entry) =>
        `${entry.recordId}\t${batchId}\t${JSON.stringify(entry.proof)}\n`,
    );
    await pipeline(Readable.from(lines), copyStream);

    await client.query("COMMIT");
    return batchId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markSubmitted(
  db: Queryable,
  batchId: number,
  transactionHash: string,
): Promise<void> {
  await db.query(
    `UPDATE 
          batches
      SET
          status = 'submitted',
          transaction_hash = $2
      WHERE 
          id = $1`,
    [batchId, transactionHash],
  );
}

export async function markConfirmed(
  db: Queryable,
  batchId: number,
  block: { number: number; timestamp: number },
): Promise<void> {
  await db.query(
    `
      UPDATE 
          batches
      SET
          status = 'confirmed',
          block_number = $2,
          block_timestamp = to_timestamp($3),
          confirmed_at = NOW()
      WHERE 
          id = $1
    `,
    [batchId, block.number, block.timestamp],
  );
}

export async function markFailed(
  db: Queryable,
  batchId: number,
  errorMessage: string,
): Promise<void> {
  await db.query(
    `
      UPDATE 
          batches
      SET
          status = 'failed',
          error_message = $2,
          retry_count = retry_count + 1
      WHERE 
          id = $1
    `,
    [batchId, errorMessage],
  );
}

/** Phase 0: the non-terminal batches that reconciliation must resolve. */
export async function findInFlightBatches(db: Queryable): Promise<Batch[]> {
  const { rows } = await db.query(
    `
      SELECT
          id,
          status,
          merkle_root,
          size,
          transaction_hash,
          block_number,
          retry_count,
          error_message
      FROM
          batches
      WHERE
          status IN ('pending', 'submitted', 'failed')
      ORDER BY
          created_at ASC
    `,
    [],
  );

  return (rows as BatchRowDb[]).map(toBatch);
}

/**
 * Streams a batch's pinned records (for rebuilding its tree during a `failed`
 * retry). Cursor-based — a failed batch can be large.
 */
// candidate for a shared streamRows helper (see records-source.ts)
export async function* streamBatchRecords(
  pool: Pool,
  batchId: number,
  batchSize = 10_000,
): AsyncGenerator<BatchRecord> {
  const client = await pool.connect();
  try {
    const stream = client.query(
      new QueryStream(
        `
          SELECT
              r.id,
              r.payload,
              r.signature,
              r.client_address
          FROM
              anchor_records ar
              JOIN records r ON r.id = ar.record_id
          WHERE
              ar.batch_id = $1
          ORDER BY
              r.id ASC
        `,
        [batchId],
        { batchSize },
      ),
    );

    for await (const row of stream as AsyncIterable<BatchRecordRowDb>) {
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
