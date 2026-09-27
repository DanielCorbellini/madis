import type { Queryable } from "service-runtime";

/**
 * Every batch this cycle must audit — the full-rescan policy (spec §3):
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
 * Every batch this cycle must individually verify still exists on-chain
 * (spec §3.1) — a `'submitted'` batch is the one status counted by the
 * root count check (below) that isn't already covered by the confirmed
 * rescan, so it's the only status a padding attack could otherwise use.
 */
export async function findSubmittedBatchIds(db: Queryable): Promise<number[]> {
  const { rows } = await db.query(
    `SELECT id FROM batches WHERE status = 'submitted' ORDER BY created_at ASC`,
  );
  return (rows as Array<{ id: string }>).map((row) => Number(row.id));
}

/**
 * How many batches Postgres currently considers on-chain-or-on-the-way —
 * the denominator the root count check (spec §3.1) compares against the
 * contract's own `getRootCount()`. `'confirmed'` and `'submitted'` are
 * the only two statuses a genuinely-anchored batch can be in.
 */
export async function countTrackedBatches(db: Queryable): Promise<number> {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS count FROM batches WHERE status IN ('confirmed', 'submitted')`,
  );
  return Number((rows as Array<{ count: string }>)[0].count);
}
