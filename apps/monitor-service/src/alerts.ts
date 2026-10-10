import type { Queryable } from "service-runtime";

/**
 * Records a root/count divergence for a batch — deduped per `batch_id`
 * so a repeatedly-audited batch doesn't spam alerts. `expectedRoot` is
 * null when there's no root to report (a `confirmed` batch missing
 * on-chain `BatchInfo`).
 */
export async function recordRootDivergence(
  db: Queryable,
  batchId: number | null,
  expectedRoot: string | null,
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
          AND batch_id IS NOT DISTINCT FROM $1
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
          integrity_alerts (alert_type, source, batch_id, expected_root, details)
      VALUES
          ('root_divergence', 'monitor', $1, $2, $3)
    `,
    [batchId, expectedRoot, details],
  );

  return true;
}

/**
 * Records that a specific record's recomputed leaf no longer matches its
 * anchored proof.
 */
export async function recordTampered(
  db: Queryable,
  batchId: number,
  recordId: number,
  expectedRoot: string,
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
          integrity_alerts (alert_type, source, batch_id, record_id, expected_root, details)
      VALUES
          ('record_tampered', 'monitor', $1, $2, $3, $4)
    `,
    [batchId, recordId, expectedRoot, details],
  );

  return true;
}

/**
 * Records that a batch the chain accepted is no longer tracked in Postgres
 * (its row was deleted or its status edited away). `batch_id` is null — that
 * row, and any foreign key to it, may be gone — so it is deduped by the
 * batch's on-chain root instead. Unlike the generic root-count alert (one per
 * lifetime, keyed on a null batch_id), a later, different missing batch still
 * alerts. Returns whether a new row was written.
 */
export async function recordMissingBatch(
  db: Queryable,
  root: string,
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
          AND batch_id IS NULL
          AND expected_root = $1
      LIMIT
          1
    `,
    [root],
  );

  if (existing.rows.length > 0) {
    return false;
  }

  await db.query(
    `
      INSERT INTO
          integrity_alerts (alert_type, source, batch_id, expected_root, details)
      VALUES
          ('root_divergence', 'monitor', NULL, $1, $2)
    `,
    [root, details],
  );

  return true;
}
