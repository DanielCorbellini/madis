import type { Queryable } from "service-runtime";

/**
 * Records that a batch's `anchor_records` count no longer matches its
 * on-chain size — deduped per `batch_id`, so a repeatedly-audited batch
 * doesn't spam a new alert every cycle. Returns whether a new row was written.
 */
export async function recordRootDivergence(
  db: Queryable,
  batchId: number,
  details: string,
): Promise<boolean> {
  const existing = await db.query(
    `
      SELECT
          1
      FROM
          integrity_alerts
      WHERE
          source = 'monitor'
          AND alert_type = 'root_divergence'
          AND batch_id = $1
      LIMIT
          1
    `,
    [batchId],
  );

  if (existing.rows.length > 0) {
    return false;
  }

  await db.query(
    `
      INSERT INTO
          integrity_alerts (alert_type, source, batch_id, details)
      VALUES
          ('root_divergence', 'monitor', $1, $2)
    `,
    [batchId, details],
  );
  return true;
}

/**
 * Records that a specific record's recomputed leaf no longer matches its
 * anchored proof — deduped per `record_id`, the same convention
 * `anchor-service`'s `recordSignatureMismatch` uses.
 */
export async function recordTampered(
  db: Queryable,
  batchId: number,
  recordId: number,
  details: string,
): Promise<boolean> {
  const existing = await db.query(
    `
      SELECT
          1
      FROM
          integrity_alerts
      WHERE
          source = 'monitor'
          AND alert_type = 'record_tampered'
          AND record_id = $1
      LIMIT
          1
    `,
    [recordId],
  );

  if (existing.rows.length > 0) {
    return false;
  }

  await db.query(
    `
      INSERT INTO
          integrity_alerts (alert_type, source, batch_id, record_id, details)
      VALUES
          ('record_tampered', 'monitor', $1, $2, $3)
    `,
    [batchId, recordId, details],
  );
  return true;
}
