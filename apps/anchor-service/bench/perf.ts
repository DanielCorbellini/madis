import { computeLeafHash, isWhitelistedAddress, verifyClientSignature } from "crypto-utils";
import { Wallet } from "ethers";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { createDbPool } from "service-runtime";
import { seedRecords, TEST_MNEMONIC, truncateAll } from "../scripts/seed-records.ts";
import type { AnchorableRecord } from "../src/record.ts";
import { streamUnanchoredRecords } from "../src/records-source.ts";
import { timed, trackPeakMemory } from "../src/timing.ts";
import { buildAnchorTree, type LeafEntry } from "../src/tree.ts";
import { writeResults } from "./report.ts";

const DEFAULT_SIZES = [100, 1000, 10000, 100000, 1000000];

interface PerfRow {
  n: number;
  scanMs: number;
  validateMs: number;
  leafMs: number;
  treeMs: number;
  totalMs: number;
  rssPeakBytes: number;
  heapUsedPeakBytes: number;
  // Every field above is a number — this index signature just makes that
  // explicit to TypeScript so PerfRow[] can be passed to writeResults's
  // Array<Record<string, unknown>> parameter without a cast.
  [key: string]: number;
}

function parseCliArgs(argv: string[]): { sizes: number[] } {
  const { values } = parseArgs({
    args: argv,
    options: {
      sizes: { type: "string" },
    },
  });

  if (values.sizes === undefined) {
    return { sizes: DEFAULT_SIZES };
  }

  const sizes = values.sizes.split(",").map((raw) => Number(raw.trim()));
  for (const n of sizes) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(
        `--sizes must be a comma-separated list of positive integers, received: ${values.sizes}`,
      );
    }
  }
  return { sizes };
}

/**
 * Resets the database to exactly `n` un-anchored valid records, then runs
 * the same records-source -> validate -> leaf -> tree pipeline `cycle.ts`
 * runs in production, timing each stage separately. `validate` and `leaf`
 * call crypto-utils's primitives directly (not `validation.ts`'s
 * `validateRecord`, which fuses them) specifically so they can be timed
 * apart, and `treeMs` covers both tree-build and proof-generation
 * (crypto-utils's `buildMerkleTree` fuses those two).
 */
async function benchmarkSize(
  pool: Pool,
  adminDatabaseUrl: string,
  wallet: ReturnType<typeof Wallet.fromPhrase>,
  n: number,
): Promise<PerfRow> {
  await truncateAll(adminDatabaseUrl);
  await seedRecords(pool, wallet, "prescription", n);

  const tracker = trackPeakMemory();
  tracker.sample();
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
    records.filter(
      (record) =>
        verifyClientSignature({
          id: String(record.id),
          data: record.payload,
          signature: record.signature,
          clientAddress: record.clientAddress,
        }) && isWhitelistedAddress(record.clientAddress, [wallet.address]),
    ),
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
  const peak = tracker.peak();

  return {
    n,
    scanMs: Math.round(scanMs),
    validateMs: Math.round(validateMs),
    leafMs: Math.round(leafMs),
    treeMs: Math.round(treeMs),
    totalMs: Math.round(totalMs),
    rssPeakBytes: peak.rssBytes,
    heapUsedPeakBytes: peak.heapUsedBytes,
  };
}

async function main(): Promise<void> {
  const { sizes } = parseCliArgs(process.argv.slice(2));

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

  const wallet = Wallet.fromPhrase(TEST_MNEMONIC);
  const pool = createDbPool(databaseUrl);

  const rows: PerfRow[] = [];
  try {
    for (const n of sizes) {
      console.log(`Benchmarking n=${n}...`);
      const row = await benchmarkSize(pool, adminDatabaseUrl, wallet, n);
      console.log(row);
      rows.push(row);
    }
  } finally {
    await pool.end();
  }

  const { jsonPath, csvPath } = await writeResults("perf", rows);
  console.log(`Wrote ${jsonPath} and ${csvPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
