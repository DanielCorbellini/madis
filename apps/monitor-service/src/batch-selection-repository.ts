import type { Queryable } from "service-runtime";

/**
 * Every batch this cycle must audit, the full-rescan policy:
 * every confirmed batch, every cycle, no filtering, no `LIMIT`, no stored
 * progress state of any kind.
 */
export async function findConfirmedBatchIds(db: Queryable): Promise<number[]> {
  const { rows } = await db.query(
    `SELECT id FROM batches WHERE status = 'confirmed' ORDER BY created_at ASC`,
  );
  return (rows as Array<{ id: string }>).map((row) => Number(row.id));
}

/**
 * Every batch this cycle must individually verify still exists on-chain.
 * A `'submitted'` batch is counted as tracked but is not part of the confirmed
 * rescan, so it's the status a padding row would use; the stale check below
 * is what catches one that never lands.
 */
export async function findSubmittedBatchIds(db: Queryable): Promise<number[]> {
  const { rows } = await db.query(
    `SELECT id FROM batches WHERE status = 'submitted' ORDER BY created_at ASC`,
  );
  return (rows as Array<{ id: string }>).map((row) => Number(row.id));
}

/**
 * How many batches Postgres currently considers on-chain-or-on-the-way —
 * the denominator the root count check compares against the
 * contract's own `getRootCount()`. `'confirmed'` and `'submitted'` are
 * the only two statuses a genuinely-anchored batch can be in.
 */
export async function countTrackedBatches(db: Queryable): Promise<number> {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS count FROM batches WHERE status IN ('confirmed', 'submitted')`,
  );
  return Number((rows as Array<{ count: string }>)[0].count);
}

export type BatchStatus = "pending" | "submitted" | "confirmed" | "failed";

/**
 * The Postgres status of each requested batch id — ids with no `batches` row
 * are simply absent from the result. Callers pass the chain's own list of
 * batch ids, so which batches to look at is never decided by Postgres; this
 * only reports what Postgres currently says about them.
 */
export async function findBatchStatuses(
  db: Queryable,
  batchIds: number[],
): Promise<Map<number, BatchStatus>> {
  if (batchIds.length === 0) {
    return new Map();
  }

  const { rows } = await db.query(
    `SELECT id, status FROM batches WHERE id = ANY($1::bigint[])`,
    [batchIds],
  );

  return new Map(
    (rows as Array<{ id: string; status: BatchStatus }>).map((row) => [
      Number(row.id),
      row.status,
    ]),
  );
}
