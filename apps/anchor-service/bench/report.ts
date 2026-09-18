import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WriteResultsOutput {
  jsonPath: string;
  csvPath: string;
}

function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

/**
 * Writes `rows` as both a `.json` and a `.csv` file under `bench/results/`
 * (created if missing), named `<prefix>-<timestamp>.{json,csv}`.
 */
export async function writeResults(
  prefix: string,
  rows: Array<Record<string, unknown>>,
  resultsDir: string = path.join(import.meta.dirname, "results"),
): Promise<WriteResultsOutput> {
  if (rows.length === 0) {
    throw new Error(`writeResults("${prefix}", ...) was called with zero rows`);
  }

  await mkdir(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(resultsDir, `${prefix}-${timestamp}.json`);
  const csvPath = path.join(resultsDir, `${prefix}-${timestamp}.csv`);

  await writeFile(jsonPath, JSON.stringify(rows, null, 2));

  const header = Object.keys(rows[0]);
  const lines = [
    header.join(","),
    ...rows.map((row) => header.map((key) => toCsvCell(row[key])).join(",")),
  ];
  await writeFile(csvPath, `${lines.join("\n")}\n`);

  return { jsonPath, csvPath };
}
