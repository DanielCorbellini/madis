import { parseArgs } from "node:util";
import { DEFAULT_MAX_BATCH_SIZE, integerEnv } from "service-runtime";

/** Marks the batches this bench creates, so cleanup never touches real ones. */
export const BENCH_TX_MARKER = `0x${"be".repeat(32)}`;

export interface AuditCostOptions {
  sizes: number[];
  /** ANCHOR_MAX_BATCH_SIZE: the largest batch the configured system anchors and rebuilds in memory. */
  maxBatchSize: number;
}

export interface AuditCell {
  n: number;
  batchId: number;
}

export function parseAuditCostArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): AuditCostOptions & { cell: AuditCell | null } {
  const { values } = parseArgs({
    args: argv,
    options: {
      sizes: { type: "string" },
      cell: { type: "string" },
    },
  });

  const raw = values.sizes ?? "1000,10000,100000";
  const sizes = raw.split(",").map((part) => Number(part.trim()));
  if (sizes.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`--sizes must be a comma-separated list of positive integers, received: ${raw}`);
  }

  const maxBatchSize = integerEnv(env, "ANCHOR_MAX_BATCH_SIZE", DEFAULT_MAX_BATCH_SIZE, {
    min: 1,
  });
  const tooBig = sizes.filter((n) => n > maxBatchSize);
  if (tooBig.length > 0) {
    throw new Error(
      `size ${tooBig.join(", ")} is above the batch limit ${maxBatchSize}: the system never anchors or audits a batch that large. Set ANCHOR_MAX_BATCH_SIZE to at least ${Math.max(...tooBig)} to measure it as one batch.`,
    );
  }

  return {
    sizes,
    maxBatchSize,
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
