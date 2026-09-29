import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Pool } from "pg";

export type TamperableRecordField =
  | "payload"
  | "client_address"
  | "version"
  | "replaces"
  | "is_deleted"
  | "signature"
  | "created_at";

/**
 * Directly mutates one column of an already-anchored `records` row, as
 * `admin_user` — simulates a privileged DBA editing a row in place. Even
 * with full grants, `admin_user` still can't violate db/schema.sql's own
 * append-only CHECK constraints (e.g. version/replaces interdependency);
 * that surfaces as a normal Postgres error, not something this function
 * works around.
 */
export async function editRecordField(
  pool: Pool,
  recordId: number,
  field: TamperableRecordField,
  value: string,
): Promise<void> {
  let result;
  switch (field) {
    case "payload":
      // UPDATE records SET payload = '<value>'::jsonb WHERE id = <recordId>;
      result = await pool.query(
        "UPDATE records SET payload = $1::jsonb WHERE id = $2",
        [value, recordId],
      );
      break;
    case "client_address":
      // UPDATE records SET client_address = '<value>' WHERE id = <recordId>;
      result = await pool.query(
        "UPDATE records SET client_address = $1 WHERE id = $2",
        [value, recordId],
      );
      break;
    case "version":
      // UPDATE records SET version = <value>::integer WHERE id = <recordId>;
      result = await pool.query(
        "UPDATE records SET version = $1::integer WHERE id = $2",
        [value, recordId],
      );
      break;
    case "replaces":
      // UPDATE records SET replaces = <value>::bigint WHERE id = <recordId>;
      result = await pool.query(
        "UPDATE records SET replaces = $1::bigint WHERE id = $2",
        [value, recordId],
      );
      break;
    case "is_deleted":
      // UPDATE records SET is_deleted = <value>::boolean WHERE id = <recordId>;
      result = await pool.query(
        "UPDATE records SET is_deleted = $1::boolean WHERE id = $2",
        [value, recordId],
      );
      break;
    case "signature":
      // UPDATE records SET signature = '<value>' WHERE id = <recordId>;
      result = await pool.query(
        "UPDATE records SET signature = $1 WHERE id = $2",
        [value, recordId],
      );
      break;
    case "created_at":
      // UPDATE records SET created_at = '<value>'::timestamptz WHERE id = <recordId>;
      result = await pool.query(
        "UPDATE records SET created_at = $1::timestamptz WHERE id = $2",
        [value, recordId],
      );
      break;
  }

  if (!result.rowCount) {
    throw new Error(`no record with id ${recordId}`);
  }
}

/** Deletes an already-anchored records row outright — simulates a DBA erasing a row. */
export async function deleteRecord(pool: Pool, recordId: number): Promise<void> {
  // DELETE FROM records WHERE id = <recordId>;
  const result = await pool.query("DELETE FROM records WHERE id = $1", [recordId]);
  if (!result.rowCount) {
    throw new Error(`no record with id ${recordId}`);
  }
}

/**
 * Deletes only the anchor_records pin for a record, leaving the record
 * itself untouched — simulates hiding a record from monitor-service's
 * anchor-count check (docs/en/MONITOR_SERVICE_EXECUTION_CYCLE.md Phase 3
 * step 2) without editing its content.
 */
export async function deleteAnchorPin(pool: Pool, recordId: number): Promise<void> {
  // DELETE FROM anchor_records WHERE record_id = <recordId>;
  const result = await pool.query(
    "DELETE FROM anchor_records WHERE record_id = $1",
    [recordId],
  );
  if (!result.rowCount) {
    throw new Error(`no anchor_records pin for record ${recordId}`);
  }
}

/**
 * Deletes an entire batch and its anchor_records pins — simulates hiding a
 * whole batch from monitor-service's per-batch rescan (which only ever
 * queries batches still present in Postgres). Only monitor-service's Phase 1
 * root-count check (contract getRootCount() vs. tracked batches) can catch
 * this, since the rescan itself has nothing left to iterate over.
 * anchor_records rows are deleted first — anchor_records_batch_id_fkey
 * would otherwise reject deleting the batches row while pins still
 * reference it.
 */
export async function deleteBatch(pool: Pool, batchId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // DELETE FROM anchor_records WHERE batch_id = <batchId>;
    await client.query("DELETE FROM anchor_records WHERE batch_id = $1", [batchId]);
    // DELETE FROM batches WHERE id = <batchId>;
    const result = await client.query("DELETE FROM batches WHERE id = $1", [batchId]);
    if (!result.rowCount) {
      throw new Error(`no batch with id ${batchId}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Corrupts only the batch's stored merkle_root, leaving records/anchor_records
 * untouched — demonstrates that monitor-service's audit never trusts this
 * column post-confirmation (it always calls getBatchInfo() on-chain instead),
 * so this alone is expected to produce no alert at all.
 */
export async function editMerkleRoot(
  pool: Pool,
  batchId: number,
  newRoot: string,
): Promise<void> {
  // UPDATE batches SET merkle_root = '<newRoot>' WHERE id = <batchId>;
  const result = await pool.query(
    "UPDATE batches SET merkle_root = $1 WHERE id = $2",
    [newRoot, batchId],
  );
  if (!result.rowCount) {
    throw new Error(`no batch with id ${batchId}`);
  }
}

/**
 * Corrupts a record's stored merkle_proof, record data untouched —
 * demonstrates that a forged/garbage proof can't be used to hide anything,
 * since verification always checks the proof against the immutable
 * on-chain root, never the proof's validity in isolation.
 */
export async function editMerkleProof(
  pool: Pool,
  recordId: number,
  newProof: string[],
): Promise<void> {
  // UPDATE anchor_records SET merkle_proof = '<newProof as JSON>'::jsonb WHERE record_id = <recordId>;
  const result = await pool.query(
    "UPDATE anchor_records SET merkle_proof = $1::jsonb WHERE record_id = $2",
    [JSON.stringify(newProof), recordId],
  );
  if (!result.rowCount) {
    throw new Error(`no anchor_records pin for record ${recordId}`);
  }
}

/**
 * Inserts a fake 'submitted' batches row with no real transaction and no
 * matching anchor_records — simulates padding used to compensate for a
 * hidden real batch (see deleteBatch above) and keep
 * monitor-service's Phase 1 root-count check balanced. Only Phase 5's
 * staleness check (MONITOR_SUBMITTED_STALE_MS) can eventually catch this,
 * since it has no real on-chain BatchInfo to ever resolve to.
 */
export async function forgeSubmittedBatch(
  pool: Pool,
  recordCount: number,
): Promise<number> {
  const fakeRoot = `0x${"f".repeat(64)}`;
  const fakeTxHash = `0x${"d".repeat(64)}`;
  // INSERT INTO batches (status, merkle_root, size, transaction_hash) VALUES ('submitted', '<fakeRoot>', <recordCount>, '<fakeTxHash>') RETURNING id;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO batches (status, merkle_root, size, transaction_hash)
     VALUES ('submitted', $1, $2, $3)
     RETURNING id`,
    [fakeRoot, recordCount, fakeTxHash],
  );
  return Number(rows[0].id);
}

export type TamperCommand =
  | { command: "edit-record"; recordId: number; field: TamperableRecordField; value: string }
  | { command: "delete-record"; recordId: number }
  | { command: "delete-anchor-pin"; recordId: number }
  | { command: "delete-batch"; batchId: number }
  | { command: "edit-merkle-root"; batchId: number; root: string }
  | { command: "edit-merkle-proof"; recordId: number; proof: string[] }
  | { command: "forge-submitted"; recordCount: number };

const TAMPERABLE_FIELDS: TamperableRecordField[] = [
  "payload",
  "client_address",
  "version",
  "replaces",
  "is_deleted",
  "signature",
  "created_at",
];

function parsePositiveInt(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

export function parseTamperArgs(argv: string[]): TamperCommand {
  const [command, ...rest] = argv;

  switch (command) {
    case "edit-record": {
      const { values } = parseArgs({
        args: rest,
        options: {
          id: { type: "string" },
          field: { type: "string" },
          value: { type: "string" },
        },
      });
      const recordId = parsePositiveInt(values.id, "--id");
      if (!TAMPERABLE_FIELDS.includes(values.field as TamperableRecordField)) {
        throw new Error(`--field must be one of: ${TAMPERABLE_FIELDS.join(", ")}`);
      }
      if (values.value === undefined) {
        throw new Error("--value is required");
      }
      return {
        command: "edit-record",
        recordId,
        field: values.field as TamperableRecordField,
        value: values.value,
      };
    }
    case "delete-record": {
      const { values } = parseArgs({ args: rest, options: { id: { type: "string" } } });
      return { command: "delete-record", recordId: parsePositiveInt(values.id, "--id") };
    }
    case "delete-anchor-pin": {
      const { values } = parseArgs({
        args: rest,
        options: { "record-id": { type: "string" } },
      });
      return {
        command: "delete-anchor-pin",
        recordId: parsePositiveInt(values["record-id"], "--record-id"),
      };
    }
    case "delete-batch": {
      const { values } = parseArgs({
        args: rest,
        options: { "batch-id": { type: "string" } },
      });
      return {
        command: "delete-batch",
        batchId: parsePositiveInt(values["batch-id"], "--batch-id"),
      };
    }
    case "edit-merkle-root": {
      const { values } = parseArgs({
        args: rest,
        options: { "batch-id": { type: "string" }, root: { type: "string" } },
      });
      if (!values.root) {
        throw new Error("--root is required");
      }
      return {
        command: "edit-merkle-root",
        batchId: parsePositiveInt(values["batch-id"], "--batch-id"),
        root: values.root,
      };
    }
    case "edit-merkle-proof": {
      const { values } = parseArgs({
        args: rest,
        options: { "record-id": { type: "string" }, proof: { type: "string" } },
      });
      const recordId = parsePositiveInt(values["record-id"], "--record-id");
      let proof: unknown;
      try {
        proof = JSON.parse(values.proof ?? "");
      } catch {
        throw new Error("--proof must be a JSON array of hex strings");
      }
      if (!Array.isArray(proof)) {
        throw new Error("--proof must be a JSON array of hex strings");
      }
      return { command: "edit-merkle-proof", recordId, proof: proof as string[] };
    }
    case "forge-submitted": {
      const { values } = parseArgs({
        args: rest,
        options: { "record-count": { type: "string" } },
      });
      return {
        command: "forge-submitted",
        recordCount: parsePositiveInt(values["record-count"], "--record-count"),
      };
    }
    default:
      throw new Error(
        `Unknown tamper command: ${command ?? "(none)"}. Expected one of: edit-record, delete-record, delete-anchor-pin, delete-batch, edit-merkle-root, edit-merkle-proof, forge-submitted`,
      );
  }
}

async function main(): Promise<void> {
  const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminDatabaseUrl) {
    throw new Error(
      "ADMIN_DATABASE_URL environment variable is required (the admin_user DSN — see db/setup-users.sql)",
    );
  }

  const parsed = parseTamperArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: adminDatabaseUrl });
  try {
    switch (parsed.command) {
      case "edit-record":
        await editRecordField(pool, parsed.recordId, parsed.field, parsed.value);
        console.log(`Edited records.${parsed.field} for id ${parsed.recordId}.`);
        break;
      case "delete-record":
        await deleteRecord(pool, parsed.recordId);
        console.log(`Deleted records row ${parsed.recordId}.`);
        break;
      case "delete-anchor-pin":
        await deleteAnchorPin(pool, parsed.recordId);
        console.log(`Deleted anchor_records pin for record ${parsed.recordId}.`);
        break;
      case "delete-batch":
        await deleteBatch(pool, parsed.batchId);
        console.log(`Deleted batch ${parsed.batchId} and its anchor_records pins.`);
        break;
      case "edit-merkle-root":
        await editMerkleRoot(pool, parsed.batchId, parsed.root);
        console.log(`Edited batches.merkle_root for batch ${parsed.batchId}.`);
        break;
      case "edit-merkle-proof":
        await editMerkleProof(pool, parsed.recordId, parsed.proof);
        console.log(`Edited anchor_records.merkle_proof for record ${parsed.recordId}.`);
        break;
      case "forge-submitted": {
        const batchId = await forgeSubmittedBatch(pool, parsed.recordCount);
        console.log(`Forged a 'submitted' batch (id ${batchId}) with no real transaction.`);
        break;
      }
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
