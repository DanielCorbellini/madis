import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeResults, type RunMetadata } from "service-runtime";
import type { CrossChainRow } from "./types.ts";

const PREFIX = "cross-chain";

export async function loadRun(resultsDir: string, runId: string): Promise<CrossChainRow[] | null> {
  try {
    const text = await readFile(path.join(resultsDir, `${PREFIX}-${runId}.json`), "utf8");
    return JSON.parse(text) as CrossChainRow[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Rewrites the run's files with every row so far, sorted by tick then network. */
export async function saveRun(
  resultsDir: string,
  runId: string,
  rows: CrossChainRow[],
  meta: RunMetadata,
): Promise<void> {
  const sorted = [...rows].sort((a, b) => a.tick - b.tick || a.network.localeCompare(b.network));
  await writeResults(PREFIX, sorted, resultsDir, meta, runId);
}
