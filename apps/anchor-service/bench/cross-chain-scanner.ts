import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { collectRunMetadata, writeResults } from "service-runtime";
import type { HistoryDay } from "./cross-chain/history.ts";
import { buildScannerDays, parseScannerCsv, periodStatistics, type Statistic } from "./cross-chain/scanner.ts";

const RESULTS_DIR = path.join(import.meta.dirname, "results");
const KINDS = ["ethereum", "polygon", "arbitrum"] as const;
const SOURCES = {
  ethereum: "https://etherscan.io/chart/gasprice",
  polygon: "https://polygonscan.com/chart/gasprice",
  arbitrum: "https://arbiscan.io/chart/gasprice",
};

/**
 * Derives from a fetched history the two series the projection reads when the
 * gas price comes from the block explorers' daily averages:
 * `cross-chain-history-scanner-{mean,median}-<history timestamp>`. The fetched
 * history itself is left untouched.
 */
async function main(): Promise<void> {
  const startedAt = new Date();
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { history: { type: "string" }, "csv-dir": { type: "string" } },
  });
  if (!values.history || !values["csv-dir"]) {
    throw new Error("usage: bench:cross-chain-scanner --history <history timestamp> --csv-dir <dir with export-AvgGasPrice-{ethereum,polygon,arbitrum}.csv>");
  }
  const csvDir = path.resolve(process.env.INIT_CWD ?? process.cwd(), values["csv-dir"]);

  const history = JSON.parse(
    await readFile(path.join(RESULTS_DIR, `cross-chain-history-${values.history}.json`), "utf8"),
  ) as HistoryDay[];
  const [ethereum, polygon, arbitrum] = await Promise.all(
    KINDS.map(async (kind) => parseScannerCsv(await readFile(path.join(csvDir, `export-AvgGasPrice-${kind}.csv`), "utf8"))),
  );
  const prices = { ethereum, polygon, arbitrum };

  for (const statistic of ["mean", "median"] as Statistic[]) {
    const days = buildScannerDays(history, prices, statistic);
    const period = periodStatistics(days);
    const { jsonPath } = await writeResults(
      `cross-chain-history-scanner-${statistic}`,
      days,
      RESULTS_DIR,
      {
        ...collectRunMetadata({ history: values.history, statistic }, startedAt),
        window: { from: history[0]?.date, to: history.at(-1)?.date },
        gasPriceSources: SOURCES,
        otherFields: `token price, PTAX and Arbitrum L1 gas from cross-chain-history-${values.history}`,
        period,
      },
      values.history,
    );
    console.log(`Wrote ${jsonPath}`);
    if (statistic === "median") {
      for (const [kind, stats] of Object.entries(period)) {
        console.log(`${kind}: ${stats.days} days, mean ${Math.round(stats.meanWei)} wei, median ${stats.medianWei} wei`);
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
