import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface WriteResultsOutput {
  jsonPath: string;
  csvPath: string;
  metaPath: string | null;
}

/** Machine, code and options a bench run used, so a chart can be traced back to it. */
export interface RunMetadata {
  cpuModel: string;
  cpuCores: number;
  totalMemBytes: number;
  platform: string;
  osRelease: string;
  nodeVersion: string;
  gitCommit: string | null;
  gitDirty: boolean | null;
  options: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
  [extra: string]: unknown;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function collectRunMetadata(
  options: Record<string, unknown>,
  startedAt: Date,
  finishedAt: Date = new Date(),
): RunMetadata {
  const cpus = os.cpus();
  const status = git(["status", "--porcelain"]);

  return {
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCores: cpus.length,
    totalMemBytes: os.totalmem(),
    platform: os.platform(),
    osRelease: os.release(),
    nodeVersion: process.version,
    gitCommit: git(["rev-parse", "--short", "HEAD"]),
    gitDirty: status === null ? null : status.length > 0,
    options,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}

function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

/**
 * Writes `rows` as `<prefix>-<timestamp>.{json,csv}` under `resultsDir`
 * (created if missing), plus `<prefix>-<timestamp>.meta.json` when
 * `metadata` is given.
 */
export async function writeResults(
  prefix: string,
  rows: Array<Record<string, unknown>>,
  resultsDir: string,
  metadata?: RunMetadata,
): Promise<WriteResultsOutput> {
  if (rows.length === 0) {
    throw new Error(`writeResults("${prefix}", ...) was called with zero rows`);
  }

  await mkdir(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = path.join(resultsDir, `${prefix}-${timestamp}`);
  const jsonPath = `${stem}.json`;
  const csvPath = `${stem}.csv`;

  await writeFile(jsonPath, JSON.stringify(rows, null, 2));

  const header = Object.keys(rows[0]);
  const lines = [
    header.join(","),
    ...rows.map((row) => header.map((key) => toCsvCell(row[key])).join(",")),
  ];
  await writeFile(csvPath, `${lines.join("\n")}\n`);

  let metaPath: string | null = null;
  if (metadata) {
    metaPath = `${stem}.meta.json`;
    await writeFile(metaPath, JSON.stringify(metadata, null, 2));
  }

  return { jsonPath, csvPath, metaPath };
}
