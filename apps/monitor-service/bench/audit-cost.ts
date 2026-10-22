import { buildMerkleTree, computeMerkleRoot } from "crypto-utils";
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Pool } from "pg";
import {
  collectRunMetadata,
  createDbPool,
  DEFAULT_MAX_BATCH_SIZE,
  integerEnv,
  parseBenchSizes,
  parseRepeats,
  repeatsFor,
  timed,
  toAnchorableRecord,
  trackCpu,
  trackPeakMemory,
  writeResults,
  type RecordRow,
} from "service-runtime";
import { streamAnchoredRecords } from "../src/audit-repository.ts";
import { computeRecordLeaf, verifyAnchoredRecord } from "../src/record-verification.ts";

/** Marks the batches this bench creates, so cleanup never touches real ones. */
export const BENCH_TX_MARKER = `0x${"be".repeat(32)}`;

export interface AuditCostOptions {
  sizes: number[];
  /** ANCHOR_MAX_BATCH_SIZE: the largest batch the configured system anchors and rebuilds in memory. */
  maxBatchSize: number;
  /** Timed repetitions per size, after one discarded warm-up. */
  repeats: number;
  /** Repetitions for sizes above LARGE_SIZE_THRESHOLD. */
  repeatsLarge: number;
}

export interface AuditCell {
  n: number;
  batchId: number;
  repeats: number;
}

export function parseAuditCostArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): AuditCostOptions & { cell: AuditCell | null } {
  const { values } = parseArgs({
    args: argv,
    options: {
      sizes: { type: "string" },
      repeats: { type: "string" },
      "repeats-large": { type: "string" },
      cell: { type: "string" },
    },
  });

  const maxBatchSize = integerEnv(env, "ANCHOR_MAX_BATCH_SIZE", DEFAULT_MAX_BATCH_SIZE, {
    min: 1,
  });
  const sizes = parseBenchSizes(values.sizes, maxBatchSize);

  return {
    sizes,
    maxBatchSize,
    repeats: parseRepeats(values.repeats, "--repeats", 10),
    repeatsLarge: parseRepeats(values["repeats-large"], "--repeats-large", 3),
    cell: values.cell === undefined ? null : (JSON.parse(values.cell) as AuditCell),
  };
}

export interface RecordSummary {
  count: number;
  minId: number | null;
  maxId: number | null;
  /** Rows in 1..maxSize that aren't prescription version 1. */
  otherTypeOrVersion: number;
  /** Batches whose transaction_hash isn't this bench's marker. */
  foreignBatches: number;
}

/** The records the anchor perf leaves behind, and nothing anchored for real (spec §4). */
export function checkAuditPrerequisites(summary: RecordSummary, maxSize: number): string[] {
  const problems: string[] = [];
  const { count, minId, maxId } = summary;

  if (maxId === null || maxId < maxSize) {
    problems.push(`only ${count} records exist, the largest size needs ${maxSize}`);
  } else if (minId !== 1 || count !== maxId - minId + 1) {
    problems.push(`record ids aren't contiguous from 1 (${count} records, ids ${minId}..${maxId})`);
  }
  if (summary.otherTypeOrVersion > 0) {
    problems.push(
      `${summary.otherTypeOrVersion} of the first ${maxSize} records aren't prescription version 1`,
    );
  }
  if (summary.foreignBatches > 0) {
    problems.push(
      `${summary.foreignBatches} batches exist that this bench didn't create — it won't mix with or delete real anchored data`,
    );
  }

  return problems;
}

export async function summarizeRecords(db: Pool, maxSize: number): Promise<RecordSummary> {
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM records)::int AS count,
            (SELECT min(id) FROM records)::int AS "minId",
            (SELECT max(id) FROM records)::int AS "maxId",
            (SELECT count(*) FROM records
              WHERE id <= $1 AND (record_type <> 'prescription' OR version <> 1))::int AS "otherTypeOrVersion",
            (SELECT count(*) FROM batches
              WHERE transaction_hash IS DISTINCT FROM $2)::int AS "foreignBatches"`,
    [maxSize, BENCH_TX_MARKER],
  );
  return rows[0] as RecordSummary;
}

/** Deletes only the batches this bench created (and their pins); returns how many. */
export async function cleanupBenchBatches(admin: Pool): Promise<number> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM anchor_records WHERE batch_id IN (SELECT id FROM batches WHERE transaction_hash = $1)",
      [BENCH_TX_MARKER],
    );
    const { rowCount } = await client.query("DELETE FROM batches WHERE transaction_hash = $1", [
      BENCH_TX_MARKER,
    ]);
    await client.query("COMMIT");
    return rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const PIN_CHUNK = 5_000;

/**
 * Untimed: anchors records 1..n as one marked batch, with proofs, the way the
 * anchor would have, minus the chain (spec §4).
 */
export async function setupBatch(admin: Pool, n: number): Promise<{ batchId: number; root: string }> {
  const { rows } = await admin.query<RecordRow>(
    `SELECT id, entity_id, record_type, payload, version, is_deleted, replaces,
            client_address, signature, created_at
     FROM records WHERE id <= $1 ORDER BY id`,
    [n],
  );
  const records = rows.map(toAnchorableRecord);
  const { root, proofs } = buildMerkleTree(records.map(computeRecordLeaf));

  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    const { rows: batch } = await client.query(
      `INSERT INTO batches (status, merkle_root, size, transaction_hash)
       VALUES ('confirmed', $1, $2, $3) RETURNING id`,
      [root, records.length, BENCH_TX_MARKER],
    );
    const batchId = Number(batch[0].id);

    for (let start = 0; start < records.length; start += PIN_CHUNK) {
      const end = Math.min(start + PIN_CHUNK, records.length);
      await client.query(
        `INSERT INTO anchor_records (record_id, batch_id, merkle_proof)
         SELECT record_id, $2, proof::jsonb FROM unnest($1::bigint[], $3::text[]) AS t(record_id, proof)`,
        [
          records.slice(start, end).map((r) => r.id),
          batchId,
          proofs.slice(start, end).map((proof) => JSON.stringify(proof)),
        ],
      );
    }
    await client.query("COMMIT");
    return { batchId, root };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Timed: the audit fast path's work for one batch, minus the chain call (spec §3). */
export async function timeAudit(
  app: Pool,
  batchId: number,
  expectedRoot: string,
): Promise<{
  readMs: number;
  leafMs: number;
  rootMs: number;
  totalMs: number;
  rootMatches: boolean;
  drillDownMs: number;
  proofsValid: boolean;
}> {
  const { result: entries, ms: readMs } = await timed(async () => {
    const collected = [];
    for await (const entry of streamAnchoredRecords(app, batchId)) collected.push(entry);
    return collected;
  });
  const { result: leaves, ms: leafMs } = await timed(async () =>
    entries.map((entry) => computeRecordLeaf(entry.record)),
  );
  const { result: root, ms: rootMs } = await timed(async () => computeMerkleRoot(leaves));
  // The path that locates a tampered record: every record's own proof against the anchored
  // root. It only runs when the root diverges, so it stays out of totalMs.
  const { result: verifications, ms: drillDownMs } = await timed(async () =>
    entries.map((entry) => verifyAnchoredRecord(entry.record, entry.proof, expectedRoot)),
  );

  return {
    readMs,
    leafMs,
    rootMs,
    totalMs: readMs + leafMs + rootMs,
    rootMatches: root === expectedRoot,
    drillDownMs,
    proofsValid: verifications.every((verification) => verification.verified),
  };
}

type Row = Record<string, unknown>;

const SELF = fileURLToPath(import.meta.url);

// Each size runs in its own process, so its peak RSS and JIT state don't leak into the next.
function runCellInChild(cell: AuditCell, sizes: number[]): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const child = fork(SELF, ["--cell", JSON.stringify(cell), "--sizes", sizes.join(",")]);
    let rows: Row[] | null = null;

    child.on("message", (message) => {
      rows = message as Row[];
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && rows) resolve(rows);
      else reject(new Error(`size ${cell.n} exited with code ${code}`));
    });
  });
}

/** One size's timed pass, as the child runs it; throws if the rebuilt root doesn't match. */
export async function measureCell(app: Pool, cell: AuditCell, expectedRoot: string): Promise<Row> {
  // Open the connection first, so the timed read doesn't pay TCP + auth setup.
  await app.query("SELECT 1");
  const memory = trackPeakMemory();
  const cpu = trackCpu();
  memory.sample();
  const timing = await timeAudit(app, cell.batchId, expectedRoot);
  memory.sample();
  const { userMs, systemMs } = cpu.stop();

  if (!timing.rootMatches || !timing.proofsValid) {
    throw new Error(`size ${cell.n}: rebuilt root doesn't match the stored one — the data changed after setup`);
  }

  return {
    n: cell.n,
    readMs: Math.round(timing.readMs),
    leafMs: Math.round(timing.leafMs),
    rootMs: Math.round(timing.rootMs),
    totalMs: Math.round(timing.totalMs),
    drillDownMs: Math.round(timing.drillDownMs),
    cpuUserMs: Math.round(userMs),
    cpuSystemMs: Math.round(systemMs),
    cpuPercent:
      timing.totalMs > 0 ? Math.round(((userMs + systemMs) / timing.totalMs) * 1000) / 10 : 0,
    rssPeakBytes: memory.peak().rssBytes,
  };
}

/**
 * Steady state, as the long-running daemon would be: one discarded warm-up
 * pass, then `cell.repeats` timed passes in the same process.
 */
export async function measureRepetitions(
  app: Pool,
  cell: AuditCell,
  expectedRoot: string,
): Promise<Row[]> {
  await measureCell(app, cell, expectedRoot);
  const rows: Row[] = [];
  for (let repetition = 1; repetition <= cell.repeats; repetition++) {
    rows.push({ ...(await measureCell(app, cell, expectedRoot)), repetition });
  }
  return rows;
}

async function runChild(cell: AuditCell, expectedRoot: string): Promise<void> {
  const app = createDbPool(requireEnv("DATABASE_URL"));
  try {
    const rows = await measureRepetitions(app, cell, expectedRoot);
    await new Promise<void>((resolve, reject) =>
      process.send!(rows, (error: Error | null) => (error ? reject(error) : resolve())),
    );
  } finally {
    await app.end();
  }
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} environment variable is required`);
  return value;
}

const SETUP_HELP = [
  "Setup (spec §4), with both daemons stopped:",
  "  1. pnpm --filter anchor-service bench:perf --sizes <the same sizes>   (leaves the largest size's records, unanchored)",
  "  2. pnpm --filter monitor-service bench:audit-cost --sizes <the same sizes>",
].join("\n");

async function main(): Promise<void> {
  const startedAt = new Date();
  const { cell, ...options } = parseAuditCostArgs(process.argv.slice(2));

  if (cell) {
    // The parent passes the stored root through the environment of this one child.
    await runChild(cell, requireEnv("AUDIT_COST_EXPECTED_ROOT"));
    return;
  }

  const maxSize = Math.max(...options.sizes);
  const admin = createDbPool(requireEnv("ADMIN_DATABASE_URL"));
  requireEnv("DATABASE_URL");

  const rows: Row[] = [];
  let failure: { n: number; error: string } | null = null;
  try {
    const problems = checkAuditPrerequisites(await summarizeRecords(admin, maxSize), maxSize);
    if (problems.length > 0) {
      console.error(`The database doesn't hold what this run needs:\n  - ${problems.join("\n  - ")}\n`);
      console.error(SETUP_HELP);
      process.exitCode = 1;
      return;
    }
    console.log("Reminder: anchor-service and monitor-service must be stopped while this runs.");

    for (const n of [...options.sizes].sort((a, b) => a - b)) {
      await cleanupBenchBatches(admin);
      console.log(`Setting up a batch of ${n} records (untimed)...`);
      const { batchId, root } = await setupBatch(admin, n);
      try {
        process.env.AUDIT_COST_EXPECTED_ROOT = root;
        const repeats = repeatsFor(n, options.repeats, options.repeatsLarge);
        const sizeRows = await runCellInChild({ n, batchId, repeats }, options.sizes);
        const totals = sizeRows.map((row) => row.totalMs as number);
        const mean = totals.reduce((sum, ms) => sum + ms, 0) / totals.length;
        console.log(`  n=${n}: ${repeats} repetitions, mean total ${Math.round(mean)} ms (${totals.join(", ")})`);
        rows.push(...sizeRows);
      } catch (error) {
        failure = { n, error: error instanceof Error ? error.message : String(error) };
        break;
      }
    }
    await cleanupBenchBatches(admin);
  } finally {
    await admin.end();
  }

  const metadata = collectRunMetadata(options, startedAt);
  if (failure) Object.assign(metadata, { incomplete: true, failedCell: failure.n, error: failure.error });
  if (rows.length > 0) {
    const { csvPath } = await writeResults(
      "monitor-audit-cost",
      rows,
      path.join(import.meta.dirname, "results"),
      metadata,
    );
    console.log(`Wrote ${csvPath}`);
  }
  if (failure) {
    console.error(`Size ${failure.n} failed: ${failure.error}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
