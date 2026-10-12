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

/**
 * Records that a record could not even be hashed while rebuilding a batch's
 * tree during reconciliation (e.g. a malformed client_address) — itself
 * evidence the record was tampered with. Deduped by `record_id`, same as
 * `recordSignatureMismatch`: a batch stuck on a permanently-bad row is
 * retried every reconcile cycle but alerted only once. Returns whether a
 * new row was written.
 */
export async function recordHashFailure(
  db: Queryable,
  recordId: number,
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
          source = 'anchor'
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
          ('record_tampered', 'anchor', $1, $2, $3)
    `,
    [batchId, recordId, details],
  );
  return true;
}

/**
 * Records that a rebuilt Merkle root already exists on-chain under a batch
 * id other than the caller's (the contract's own RootAlreadyExists rule).
 * `batchId` is the caller's own batch row when one exists, or null when none
 * was created (the skip path; `integrity_alerts.batch_id` has an FK to
 * `batches`, and the owner's row may not exist). Deduped by root: a
 * permanently stalled set is re-detected every cycle but alerted only once.
 * Returns whether a new row was written.
 */
export async function recordDuplicateRoot(
  db: Queryable,
  batchId: number | null,
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
          source = 'anchor'
          AND alert_type = 'duplicate_root'
          AND actual_root = $1
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
          integrity_alerts (alert_type, source, batch_id, actual_root, details)
      VALUES
          ('duplicate_root', 'anchor', $1, $2, $3)
    `,
    [batchId, root, details],
  );

  return true;
}

/**
 * Records that a batch can no longer be reconciled safely: its rows cannot
 * rebuild the root it was stored with (a pin or record was deleted or edited),
 * its recorded state is impossible (e.g. `submitted` with no transaction hash),
 * or it has no pins at all. `expected_root` is the batch's stored root,
 * `actual_root` the root rebuilt from its current rows (null when there was
 * nothing to rebuild from). Deduped by `batch_id`: a stuck batch is
 * re-evaluated every Phase 0 but alerted only once. Returns whether a new row
 * was written.
 */
export async function recordBatchDivergence(
  db: Queryable,
  batchId: number,
  expectedRoot: string,
  actualRoot: string | null,
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
          integrity_alerts (alert_type, source, batch_id, expected_root, actual_root, details)
      VALUES
          ('root_divergence', 'anchor', $1, $2, $3, $4)
    `,
    [batchId, expectedRoot, actualRoot, details],
  );

  return true;
}

export function duplicateRootMessage(args: {
  batchId: number;
  root: string;
  ownerBatchId: number;
}): string {
  return `batch ${args.batchId}: root ${args.root} already exists on-chain (contract RootAlreadyExists) under batch ${args.ownerBatchId}, not this batch's id — not confirming; its anchor_records pins cannot be moved (no UPDATE/DELETE grant)`;
}
