import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { collectRunMetadata, writeResults } from "service-runtime";
import { createAuditSelector } from "../src/audit-selection.ts";
import { createRandomInt, type RandomInt } from "../src/random-source.ts";
import { sizingRows } from "./sizing.ts";

export type Strategy = "shuffled-pass" | "independent";

export interface Cell {
  m: number;
  k: number;
  j: number;
  strategy: Strategy;
}

interface TrialResult {
  cycles: number;
  capped: boolean;
}

const MS = [10, 100, 1000];
const KS = [1, 3, 4, 10, 34, 100];
const JS = [0, 1];
const STRATEGIES: Strategy[] = ["shuffled-pass", "independent"];
const LARGE_PASS = 100;

export function detectionGrid(): Cell[] {
  return MS.flatMap((m) =>
    KS.filter((k) => k <= m).flatMap((k) =>
      JS.flatMap((j) => STRATEGIES.map((strategy) => ({ m, k, j, strategy }))),
    ),
  );
}

const passLength = (m: number, k: number): number => Math.ceil(m / k);

export function trialsFor(
  m: number,
  k: number,
  trials: number,
  trialsLarge: number,
): number {
  return passLength(m, k) > LARGE_PASS ? trialsLarge : trials;
}

/** k distinct ids from [1..m] plus up to j more from the rest: Strategy B's fresh draw. */
export function drawIndependent(
  m: number,
  k: number,
  j: number,
  randomInt: RandomInt,
): number[] {
  const ids = Array.from({ length: m }, (_, i) => i + 1);
  const count = Math.min(m, k + Math.min(j, m - k));
  // Partial Fisher-Yates: the first `count` slots are a uniform draw.
  for (let i = 0; i < count; i++) {
    const swap = i + randomInt(m - i);
    [ids[i], ids[swap]] = [ids[swap]!, ids[i]!];
  }
  return ids.slice(0, count);
}

/** Cycles until a persistently tampered batch is audited (spec §6). */
export function runTrial(cell: Cell, randomInt: RandomInt): TrialResult {
  const { m, k, j, strategy } = cell;
  const pass = passLength(m, k);

  if (strategy === "independent") {
    const target = 1 + randomInt(m);
    const cap = 50 * pass;
    for (let cycles = 1; cycles <= cap; cycles++) {
      if (drawIndependent(m, k, j, randomInt).includes(target)) {
        return { cycles, capped: false };
      }
    }
    return { cycles: cap, capped: true };
  }

  const ids = Array.from({ length: m }, (_, i) => i + 1);
  const selector = createAuditSelector({ sampleSize: k, spotChecks: j, randomInt });
  const select = () =>
    selector.select({ chainIds: ids, confirmedIds: [], escalated: false });

  const warmUp = randomInt(2 * pass);
  for (let i = 0; i < warmUp; i++) select();

  const target = 1 + randomInt(m);
  const cap = 4 * pass + 10;
  for (let cycles = 1; cycles <= cap; cycles++) {
    const { sliceIds, spotIds } = select();
    if (sliceIds.includes(target) || spotIds.includes(target)) {
      return { cycles, capped: false };
    }
  }
  return { cycles: cap, capped: true };
}

/**
 * Exact mean detection cycles for a pass of `pass` cycles, j = 0: tampering
 * lands after a uniform number of the pass's cycles, at a uniform slot.
 */
export function theoryMeanDiscrete(pass: number): number {
  let total = 0;
  for (let done = 0; done < pass; done++) {
    const left = pass - done;
    // Unvisited slot: wait 1..left. Visited slot: rest of this pass + a slot in the next.
    total += (left * (left + 1)) / 2 + done * (left + (pass + 1) / 2);
  }
  return total / (pass * pass);
}

// Nearest-rank percentile over an ascending-sorted array.
const percentile = (sorted: number[], p: number): number =>
  sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;

export function summarizeCell(
  cell: Cell,
  results: TrialResult[],
): Record<string, unknown> {
  const cycles = results.map((r) => r.cycles).sort((a, b) => a - b);
  const pass = passLength(cell.m, cell.k);
  const mean = cycles.reduce((sum, c) => sum + c, 0) / cycles.length;

  return {
    m: cell.m,
    k: cell.k,
    j: cell.j,
    strategy: cell.strategy,
    trials: cycles.length,
    mean: Math.round(mean * 100) / 100,
    p50: percentile(cycles, 50),
    p95: percentile(cycles, 95),
    max: cycles[cycles.length - 1]!,
    cappedCount: results.filter((r) => r.capped).length,
    theoryWorst: 2 * pass - 1,
    theoryMean: cell.j === 0 ? Math.round((7 / 12) * pass * 100) / 100 : "",
    theoryMeanDiscrete:
      cell.j === 0 ? Math.round(theoryMeanDiscrete(pass) * 100) / 100 : "",
    costBatchesPerCycle: cell.k + cell.j,
  };
}

function positiveInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer, received: ${raw}`);
  }
  return value;
}

export function parseDetectionArgs(argv: string[]): {
  trials: number;
  trialsLarge: number;
  seed: string;
} {
  const { values } = parseArgs({
    args: argv,
    options: {
      trials: { type: "string" },
      "trials-large": { type: "string" },
      seed: { type: "string" },
    },
  });

  return {
    trials: positiveInt(values.trials, "--trials", 10_000),
    trialsLarge: positiveInt(values["trials-large"], "--trials-large", 1_000),
    seed: values.seed ?? "bench-1",
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const options = parseDetectionArgs(process.argv.slice(2));
  const resultsDir = path.join(import.meta.dirname, "results");

  const rows: Array<Record<string, unknown>> = [];
  let shuffledCapped = 0;

  for (const cell of detectionGrid()) {
    const trials = trialsFor(cell.m, cell.k, options.trials, options.trialsLarge);
    const results: TrialResult[] = [];
    for (let i = 0; i < trials; i++) {
      const seed = `${options.seed}:${cell.m}:${cell.k}:${cell.j}:${cell.strategy}:${i}`;
      results.push(runTrial(cell, createRandomInt(seed)));
    }

    const row = summarizeCell(cell, results);
    if (cell.strategy === "shuffled-pass") shuffledCapped += row.cappedCount as number;
    console.log(
      `M=${cell.m} k=${cell.k} j=${cell.j} ${cell.strategy}: mean ${row.mean}, max ${row.max} (${trials} trials)`,
    );
    rows.push(row);
  }

  const metadata = collectRunMetadata(options, startedAt);
  const detection = await writeResults("monitor-detection", rows, resultsDir, metadata);
  const sizing = await writeResults(
    "monitor-sizing",
    sizingRows(MS),
    resultsDir,
    metadata,
  );
  console.log(`Wrote ${detection.csvPath} and ${sizing.csvPath}`);

  if (shuffledCapped > 0) {
    console.error(
      `${shuffledCapped} shuffled-pass trial(s) hit the safety cap — that contradicts the 2L − 1 bound`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
