import type { Queryable } from "service-runtime";

/**
 * Records that a record failed the Anchor's signature / whitelist re-check and
 * was left out of its batch. Deduped by `record_id`: a permanently-bad row is
 * re-scanned every cycle but alerted only once. Returns whether a new row was
 * written.
 */
export async function recordSignatureMismatch(
  db: Queryable,
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
          source = 'anchor'
          AND alert_type = 'signature_mismatch'
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
          integrity_alerts (alert_type, source, record_id, details)
      VALUES
          ('signature_mismatch', 'anchor', $1, $2)
    `,
    [recordId, details],
  );
  return true;
}
