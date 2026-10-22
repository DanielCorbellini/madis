import {
  computeLeafHash,
  computeMerkleRoot,
  isWhitelistedAddress,
  verifyClientSignature,
} from "crypto-utils";
import { Wallet } from "ethers";
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import {
  type AnchorableRecord,
  createDbPool,
  collectRunMetadata,
  DEFAULT_MAX_BATCH_SIZE,
  integerEnv,
  parseBenchSizes,
  parseRepeats,
  repeatsFor,
  timed,
  trackCpu,
  trackPeakMemory,
  writeResults,
} from "service-runtime";
import { seedRecords, TEST_MNEMONIC, truncateAll } from "../scripts/seed-records.ts";
import { streamUnanchoredRecords } from "../src/records-source.ts";
import { buildAnchorTree, type LeafEntry } from "../src/tree.ts";

interface PerfRow {
  n: number;
  scanMs: number;
  validateMs: number;
  leafMs: number;
  treeMs: number;
  totalMs: number;
  rssPeakBytes: number;
  heapUsedPeakBytes: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuPercent: number;
  /** Building the tree alone, measured apart from the pipeline (not part of totalMs). */
  treeBuildMs: number;
  /** treeMs minus treeBuildMs: generating (and checking) every record's proof. */
  proofsMs: number;
  // Every field above is a number — this index signature just makes that
  // explicit to TypeScript so PerfRow[] can be passed to writeResults's
  // Array<Record<string, unknown>> parameter without a cast.
  [key: string]: number;
}

export interface PerfOptions {
  sizes: number[];
  /** ANCHOR_MAX_BATCH_SIZE: sizes above it aren't batches the configured system would build. */
  maxBatchSize: number;
  /** Timed repetitions per size, after one discarded warm-up. */
  repeats: number;
  /** Repetitions for sizes above LARGE_SIZE_THRESHOLD. */
  repeatsLarge: number;
}

export interface PerfCell {
  n: number;
  repeats: number;
}

export function parsePerfArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): PerfOptions & { cell: PerfCell | null } {
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

  return {
    sizes: parseBenchSizes(values.sizes, maxBatchSize),
    maxBatchSize,
    repeats: parseRepeats(values.repeats, "--repeats", 10),
    repeatsLarge: parseRepeats(values["repeats-large"], "--repeats-large", 3),
    cell: values.cell === undefined ? null : (JSON.parse(values.cell) as PerfCell),
  };
}

/**
 * Splits the production tree step (tree + every proof) into its two parts.
 * Two separate measurements can wobble, so the proofs never go negative.
 */
export function splitTreeTime(
  treeMs: number,
  treeBuildMs: number,
): { treeBuildMs: number; proofsMs: number } {
  const build = Math.min(treeBuildMs, treeMs);
  return { treeBuildMs: build, proofsMs: treeMs - build };
}

/**
 * One timed pass over the unanchored records: the same records-source ->
 * validate -> leaf -> tree pipeline `cycle.ts` runs in production, timing each
 * stage separately. `validate` and `leaf` call crypto-utils's primitives
 * directly (not `validation.ts`'s `validateRecord`, which fuses them) so they
 * can be timed apart, and `treeMs` covers both tree-build and proof-generation
 * (crypto-utils's `buildMerkleTree` fuses those two). Nothing is persisted, so
 * passes can repeat over the same records.
 */
async function measurePipeline(
  pool: Pool,
  wallet: ReturnType<typeof Wallet.fromPhrase>,
  n: number,
): Promise<PerfRow> {
  const tracker = trackPeakMemory();
  tracker.sample();
  const cpu = trackCpu();
  const totalStart = performance.now();

  const { result: records, ms: scanMs } = await timed(async () => {
    const collected: AnchorableRecord[] = [];
    for await (const record of streamUnanchoredRecords(pool)) {
      collected.push(record);
    }
    return collected;
  });
  tracker.sample();

  const { result: validated, ms: validateMs } = await timed(async () =>
    records.filter((record) => {
      const isCreate = record.replaces === null;
      return (
        verifyClientSignature({
          recordType: record.recordType,
          data: record.payload,
          version: record.version,
          isDeleted: record.isDeleted,
          replaces: record.replaces,
          entityId: isCreate ? null : record.entityId,
          signature: record.signature,
          clientAddress: record.clientAddress,
        }) && isWhitelistedAddress(record.clientAddress, [wallet.address])
      );
    }),
  );
  tracker.sample();

  const { result: leaves, ms: leafMs } = await timed(async () =>
    validated.map(
      (record): LeafEntry => ({
        recordId: record.id,
        leaf: computeLeafHash({
          id: record.id,
          entityId: record.entityId,
          recordType: record.recordType,
          data: record.payload,
          version: record.version,
          isDeleted: record.isDeleted,
          replaces: record.replaces,
          clientAddress: record.clientAddress,
          signature: record.signature,
          createdAt: record.createdAt,
        }),
      }),
    ),
  );
  tracker.sample();

  const { ms: treeMs } = await timed(async () => {
    buildAnchorTree(leaves);
  });
  tracker.sample();

  const totalMs = performance.now() - totalStart;
  const { userMs, systemMs } = cpu.stop();
  const peak = tracker.peak();

  // Outside the pipeline's timing: the same tree without proofs, to split treeMs.
  const { ms: rootOnlyMs } = await timed(async () => {
    computeMerkleRoot(leaves.map((entry) => entry.leaf));
  });
  const split = splitTreeTime(treeMs, rootOnlyMs);

  return {
    n,
    scanMs: Math.round(scanMs),
    validateMs: Math.round(validateMs),
    leafMs: Math.round(leafMs),
    treeMs: Math.round(treeMs),
    totalMs: Math.round(totalMs),
    rssPeakBytes: peak.rssBytes,
    heapUsedPeakBytes: peak.heapUsedBytes,
    cpuUserMs: Math.round(userMs),
    cpuSystemMs: Math.round(systemMs),
    cpuPercent:
      totalMs > 0 ? Math.round(((userMs + systemMs) / totalMs) * 1000) / 10 : 0,
    treeBuildMs: Math.round(split.treeBuildMs),
    proofsMs: Math.round(split.proofsMs),
  };
}

/**
 * Steady state, as the long-running daemon would be: reseed `n` records once,
 * one discarded warm-up pass, then `repeats` timed passes over the same records.
 */
async function measureSize(
  pool: Pool,
  adminDatabaseUrl: string,
  wallet: ReturnType<typeof Wallet.fromPhrase>,
  cell: PerfCell,
): Promise<PerfRow[]> {
  await truncateAll(adminDatabaseUrl);
  await seedRecords(pool, wallet, "prescription", cell.n);

  await measurePipeline(pool, wallet, cell.n);
  const rows: PerfRow[] = [];
  for (let repetition = 1; repetition <= cell.repeats; repetition++) {
    rows.push({ ...(await measurePipeline(pool, wallet, cell.n)), repetition });
  }
  return rows;
}

const SELF = fileURLToPath(import.meta.url);

// Each size runs in its own process, so its peak RSS and JIT state don't leak into the next.
function runSizeInChild(cell: PerfCell, sizes: number[]): Promise<PerfRow[]> {
  return new Promise((resolve, reject) => {
    const child = fork(SELF, ["--cell", JSON.stringify(cell), "--sizes", sizes.join(",")]);
    let rows: PerfRow[] | null = null;

    child.on("message", (message) => {
      rows = message as PerfRow[];
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && rows) resolve(rows);
      else reject(new Error(`size ${cell.n} exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const { cell, ...options } = parsePerfArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  if (!adminDatabaseUrl) {
    throw new Error(
      "ADMIN_DATABASE_URL environment variable is required (perf.ts truncates and reseeds the database between sizes)",
    );
  }

  if (cell) {
    const pool = createDbPool(databaseUrl);
    try {
      const rows = await measureSize(pool, adminDatabaseUrl, Wallet.fromPhrase(TEST_MNEMONIC), cell);
      await new Promise<void>((resolve, reject) =>
        process.send!(rows, (error: Error | null) => (error ? reject(error) : resolve())),
      );
    } finally {
      await pool.end();
    }
    return;
  }

  const rows: PerfRow[] = [];
  let failure: { n: number; error: string } | null = null;
  for (const n of [...options.sizes].sort((a, b) => a - b)) {
    const repeats = repeatsFor(n, options.repeats, options.repeatsLarge);
    console.log(`Benchmarking n=${n} (${repeats} repetitions after a warm-up)...`);
    try {
      const sizeRows = await runSizeInChild({ n, repeats }, options.sizes);
      const totals = sizeRows.map((row) => row.totalMs);
      const mean = totals.reduce((sum, ms) => sum + ms, 0) / totals.length;
      console.log(`  n=${n}: mean total ${Math.round(mean)} ms (${totals.join(", ")})`);
      rows.push(...sizeRows);
    } catch (error) {
      failure = { n, error: error instanceof Error ? error.message : String(error) };
      break;
    }
  }

  const metadata = collectRunMetadata(options, startedAt);
  if (failure) Object.assign(metadata, { incomplete: true, failedCell: failure.n, error: failure.error });
  if (rows.length > 0) {
    const { jsonPath, csvPath } = await writeResults(
      "perf",
      rows,
      path.join(import.meta.dirname, "results"),
      metadata,
    );
    console.log(`Wrote ${jsonPath} and ${csvPath}`);
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
