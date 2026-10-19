import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  collectRunMetadata,
  createDbPool,
  createLogger,
  trackCpu,
  writeResults,
} from "service-runtime";
import { createAuditDeps } from "../src/audit.ts";
import { findBatchStatuses } from "../src/batch-selection-repository.ts";
import {
  createReadOnlyChainClient,
  createRetryingContract,
  listAnchoredBatches,
} from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { createCycleDeps, runMonitorCycle, type CycleDeps } from "../src/cycle.ts";
import { createRandomInt } from "../src/random-source.ts";
import { MAIN_POLICY_CYCLES, requiredSampleSize } from "./sizing.ts";

export type PerfConfig = "full" | "sampling-k3" | "sampling-1h";

export interface CellSpec {
  m: number;
  config: PerfConfig;
  k: number | null;
  j: number | null;
  cycles: number;
}

export interface PerfOptions {
  batches: number[];
  batchSize: number;
  fullCycles: number;
  samplingCycles: number;
  seed: string;
}

type Row = Record<string, unknown>;

function positiveInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer, received: ${raw}`);
  }
  return value;
}

export function parsePerfArgs(argv: string[]): PerfOptions & { cell: CellSpec | null } {
  const { values } = parseArgs({
    args: argv,
    options: {
      batches: { type: "string" },
      "batch-size": { type: "string" },
      "full-cycles": { type: "string" },
      "sampling-cycles": { type: "string" },
      seed: { type: "string" },
      cell: { type: "string" },
    },
  });

  const batches = (values.batches ?? "10,100,1000")
    .split(",")
    .map((raw) => positiveInt(raw.trim(), "--batches", 0));

  return {
    batches,
    batchSize: positiveInt(values["batch-size"], "--batch-size", 1000),
    fullCycles: positiveInt(values["full-cycles"], "--full-cycles", 3),
    samplingCycles: positiveInt(values["sampling-cycles"], "--sampling-cycles", 10),
    seed: values.seed ?? "bench-1",
    cell: values.cell === undefined ? null : (JSON.parse(values.cell) as CellSpec),
  };
}

/** Per M: full rescan, k = 3, and the k that guarantees a 1-hour worst case (spec §4.3). */
export function cellsFor(options: PerfOptions): CellSpec[] {
  return options.batches.flatMap((m): CellSpec[] => [
    { m, config: "full", k: null, j: null, cycles: options.fullCycles },
    { m, config: "sampling-k3", k: 3, j: 1, cycles: options.samplingCycles },
    {
      m,
      config: "sampling-1h",
      k: requiredSampleSize(m, MAIN_POLICY_CYCLES),
      j: 1,
      cycles: options.samplingCycles,
    },
  ]);
}

/**
 * The real deps, seeing only `visibleIds` (spec §4.2): counts stay consistent
 * so the cycle audits exactly those batches, with real per-batch work.
 */
export function narrowCycleDeps(deps: CycleDeps, visibleIds: number[]): CycleDeps {
  const visible = new Set(visibleIds);

  return {
    ...deps,
    batches: {
      ...deps.batches,
      findConfirmedBatchIds: async () =>
        (await deps.batches.findConfirmedBatchIds()).filter((id) => visible.has(id)),
      countTrackedBatches: async () => {
        const statuses = await deps.batches.findBatchStatuses(visibleIds);
        return [...statuses.values()].filter(
          (status) => status === "confirmed" || status === "submitted",
        ).length;
      },
    },
    chain: {
      ...deps.chain,
      listAnchoredBatches: async () =>
        (await deps.chain.listAnchoredBatches()).filter((b) => visible.has(b.batchId)),
      getRootCount: async () => visibleIds.length,
    },
  };
}

export function checkPrerequisites(input: {
  chainBatchIds: number[];
  firstSize: number | null;
  lastSize: number | null;
  statuses: Map<number, string>;
  maxM: number;
  batchSize: number;
}): string[] {
  const { chainBatchIds, firstSize, lastSize, statuses, maxM, batchSize } = input;
  const problems: string[] = [];

  if (chainBatchIds.length < maxM) {
    problems.push(
      `only ${chainBatchIds.length} batches are anchored on-chain, the largest --batches value needs ${maxM}`,
    );
  }
  if (firstSize !== batchSize || lastSize !== batchSize) {
    problems.push(
      `on-chain batch size is ${firstSize ?? "?"} (first) / ${lastSize ?? "?"} (last), expected --batch-size ${batchSize}`,
    );
  }

  const notConfirmed = chainBatchIds
    .slice(0, maxM)
    .filter((id) => statuses.get(id) !== "confirmed");
  if (notConfirmed.length > 0) {
    const example = notConfirmed[0]!;
    problems.push(
      `${notConfirmed.length} of the first ${maxM} on-chain batches aren't 'confirmed' in Postgres (e.g. batch ${example}: ${statuses.get(example) ?? "no row"})`,
    );
  }

  return problems;
}

/** Runs cells in order; stops at the first failure but keeps the rows gathered so far. */
export async function runCells(
  cells: CellSpec[],
  runCell: (cell: CellSpec) => Promise<Row[]>,
): Promise<{ rows: Row[]; failedCell: CellSpec | null; error: string | null }> {
  const rows: Row[] = [];

  for (const cell of cells) {
    try {
      rows.push(...(await runCell(cell)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { rows, failedCell: cell, error: message };
    }
  }

  return { rows, failedCell: null, error: null };
}

function setupHelp(options: PerfOptions): string {
  const maxM = Math.max(...options.batches);
  return [
    "Setup (spec §4.1), with both daemons stopped:",
    "  0. fresh Hardhat node + truncated database (e.g. docker compose --profile local down -v, then up postgres hardhat-node)",
    `  1. pnpm --filter anchor-service seed --count ${options.batchSize * maxM} --type prescription --truncate`,
    `  2. run one anchor-service cycle with ANCHOR_MAX_BATCH_SIZE=${options.batchSize}`,
  ].join("\n");
}

const SELF = fileURLToPath(import.meta.url);

// Every cell runs in its own process, so one cell's peak RSS can't leak into the next.
function runCellInChild(cell: CellSpec, options: PerfOptions): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const child = fork(SELF, [
      "--cell",
      JSON.stringify(cell),
      "--batch-size",
      String(options.batchSize),
      "--seed",
      options.seed,
    ]);
    let rows: Row[] | null = null;

    child.on("message", (message) => {
      rows = message as Row[];
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && rows) resolve(rows);
      else reject(new Error(`cell ${JSON.stringify(cell)} exited with code ${code}`));
    });
  });
}

async function runChild(cell: CellSpec, options: PerfOptions): Promise<void> {
  const config = loadConfig();
  const logger = createLogger("warn");
  const pool = createDbPool(config.databaseUrl);
  const chain = createReadOnlyChainClient(config);

  try {
    const contract = createRetryingContract(chain.contract, { retries: config.rpcRetries });
    const list = () => listAnchoredBatches(chain.contract, { retries: config.rpcRetries });
    const deps = createCycleDeps(
      createAuditDeps(contract, pool, { rootRebuildMaxSize: config.rootRebuildMaxSize }),
      contract,
      pool,
      logger,
      {
        submittedStaleMs: config.submittedStaleMs,
        listAnchoredBatches: list,
        ...(cell.k !== null && {
          sampling: {
            sampleSize: cell.k,
            spotChecks: cell.j ?? 0,
            randomInt: createRandomInt(`${options.seed}:${cell.m}:${cell.config}`),
            escalateOnAnomaly: true,
          },
        }),
      },
    );
    const visibleIds = (await list()).slice(0, cell.m).map((b) => b.batchId);
    const narrowed = narrowCycleDeps(deps, visibleIds);

    const runValidCycle = async (cycle: number) => {
      const summary = await runMonitorCycle(narrowed, cycle, logger);
      if (summary.escalated || summary.alertsFired > 0) {
        throw new Error(
          `invalid run: cycle ${cycle} of ${JSON.stringify(cell)} escalated or raised alerts — the data isn't clean (${JSON.stringify(summary)})`,
        );
      }
      return summary;
    };

    await runValidCycle(0); // warm-up: connection pool, JIT
    const rows: Row[] = [];
    for (let cycle = 1; cycle <= cell.cycles; cycle++) {
      const cpu = trackCpu();
      const summary = await runValidCycle(cycle);
      const { userMs, systemMs } = cpu.stop();

      rows.push({
        m: cell.m,
        batchSize: options.batchSize,
        config: cell.config,
        k: cell.k,
        j: cell.j,
        cycle,
        durationMs: summary.durationMs,
        recordsChecked: summary.recordsChecked,
        batchesChecked: summary.batchesChecked,
        cpuUserMs: Math.round(userMs),
        cpuSystemMs: Math.round(systemMs),
        cpuPercent:
          summary.durationMs > 0
            ? Math.round(((userMs + systemMs) / summary.durationMs) * 1000) / 10
            : 0,
        peakRssBytes: summary.peakRssBytes,
      });
    }

    await new Promise<void>((resolve, reject) =>
      process.send!(rows, (error: Error | null) => (error ? reject(error) : resolve())),
    );
  } finally {
    await pool.end();
    chain.provider.destroy();
  }
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const { cell, ...options } = parsePerfArgs(process.argv.slice(2));

  if (cell) {
    await runChild(cell, options);
    return;
  }

  const maxM = Math.max(...options.batches);
  const config = loadConfig();
  const pool = createDbPool(config.databaseUrl);
  const chain = createReadOnlyChainClient(config);

  let problems: string[];
  try {
    const listed = await listAnchoredBatches(chain.contract, { retries: config.rpcRetries });
    const ids = listed.map((b) => b.batchId);
    const sizeOf = async (id: number | undefined) =>
      id === undefined ? null : Number((await chain.contract.getBatchInfo(id)).size);

    problems = checkPrerequisites({
      chainBatchIds: ids,
      firstSize: await sizeOf(ids[0]),
      lastSize: await sizeOf(ids[Math.min(maxM, ids.length) - 1]),
      statuses: await findBatchStatuses(pool, ids.slice(0, maxM)),
      maxM,
      batchSize: options.batchSize,
    });
  } finally {
    await pool.end();
    chain.provider.destroy();
  }

  if (problems.length > 0) {
    console.error(`The anchored data doesn't match this run:\n  - ${problems.join("\n  - ")}\n`);
    console.error(setupHelp(options));
    process.exitCode = 1;
    return;
  }

  console.log(
    "Reminder: anchor-service and monitor-service must be stopped while this runs (docker compose stop anchor-service monitor-service).",
  );

  const cells = cellsFor(options);
  const result = await runCells(cells, async (spec) => {
    console.log(`Running M=${spec.m} ${spec.config} (${spec.cycles} cycles)...`);
    const rows = await runCellInChild(spec, options);
    const durations = rows.map((row) => row.durationMs as number);
    console.log(`  durations (ms): ${durations.join(", ")}`);
    return rows;
  });

  const metadata = collectRunMetadata(options, startedAt);
  if (result.failedCell) {
    Object.assign(metadata, {
      incomplete: true,
      failedCell: result.failedCell,
      error: result.error,
    });
  }

  if (result.rows.length > 0) {
    const { csvPath } = await writeResults(
      "monitor-perf",
      result.rows,
      path.join(import.meta.dirname, "results"),
      metadata,
    );
    console.log(`Wrote ${csvPath}`);
  }

  if (result.failedCell) {
    console.error(`Cell ${JSON.stringify(result.failedCell)} failed: ${result.error}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
