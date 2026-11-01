import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { collectRunMetadata, writeResults, type RunMetadata } from "service-runtime";
import type { DeployGas } from "./cross-chain/deploy.ts";
import type { HistoryDay } from "./cross-chain/history.ts";
import {
  annualRows,
  blobSummary,
  cost24hRow,
  deployCost,
  meanGas,
  perRecordRows,
  projectNetwork,
  runCounts,
  statsRows,
  summaryRow,
} from "./cross-chain/projection.ts";
import { runIdFromDate } from "./cross-chain/schedule.ts";
import type { CrossChainRow, NetworkKind } from "./cross-chain/types.ts";

const RESULTS_DIR = path.join(import.meta.dirname, "results");

const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(path.join(RESULTS_DIR, file), "utf8")) as T;
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * Combines a collection run (gas, times, snapshots) with a cached price
 * history into the section's tables: summary, annual cost per frequency, cost
 * per record, deploy cost, testnet vs mainnet gas, the 24-hour cost line, the
 * spec's per-network statistics and the run's outcome counts.
 * All share one timestamp so plot.py can pin them together.
 */
async function main(): Promise<void> {
  const startedAt = new Date();
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { run: { type: "string" }, history: { type: "string" } },
  });
  if (!values.run || !values.history) {
    throw new Error("usage: bench:cross-chain-project --run <runId> --history <history timestamp>");
  }

  const rows = await readJson<CrossChainRow[]>(`cross-chain-${values.run}.json`);
  const runMeta = await readJson<RunMetadata>(`cross-chain-${values.run}.meta.json`);
  const history = await readJson<HistoryDay[]>(`cross-chain-history-${values.history}.json`);
  const networks = (runMeta.options as { networks: { name: string; kind: NetworkKind }[] }).networks;
  const deploys = runMeta.deploys as Record<string, DeployGas | null>;

  const summary = [];
  const annual = [];
  const perRecord = [];
  const deployRows = [];
  const gasRows = [];
  const cost24h = [];
  const stats = [];
  const counts = [];
  const scenarios: Record<string, unknown> = {};

  for (const { name, kind } of networks) {
    const days = history.filter((day) => day.kind === kind);
    const gas = meanGas(rows, name);
    if (days.length === 0 || gas.n === 0) {
      console.warn(`${name}: skipped (${days.length} history days, ${gas.n} usable anchorings)`);
      continue;
    }
    const projection = projectNetwork(days, gas);
    scenarios[name] = { ...projection, anchoringsUsed: gas.n };
    summary.push({ kind, ...summaryRow(name, kind, projection, rows) });
    annual.push(...annualRows(name, projection.mean).map((row) => ({ kind, ...row })));
    perRecord.push(...perRecordRows(name, projection.mean).map((row) => ({ kind, ...row })));

    const deploy = deploys[name];
    const deployMainnet = deploy?.mainnetGasEstimate ? Number(deploy.mainnetGasEstimate) : null;
    if (deploy && deployMainnet !== null) {
      const l1 = deploy.mainnetL1GasUsed ? Number(deploy.mainnetL1GasUsed) : 0;
      const cost = deployCost(days, { total: deployMainnet, l2: deployMainnet - l1 });
      deployRows.push({
        kind,
        network: name,
        testnetGasUsed: Number(deploy.gasUsed),
        mainnetGas: deployMainnet,
        costUsd: cost.usd,
        costBrl: cost.brl,
      });
    } else {
      console.warn(`${name}: no deploy gas in the run's metadata; deploy cost left out`);
    }

    gasRows.push({
      kind,
      network: name,
      anchorings: gas.n,
      anchoringTestnetGas: gas.testnet,
      anchoringMainnetGas: gas.total,
      anchoringTestnetOverMainnet: gas.testnet / gas.total,
      deployTestnetGas: deploy ? Number(deploy.gasUsed) : null,
      deployMainnetGas: deployMainnet,
      deployTestnetOverMainnet: deploy && deployMainnet ? Number(deploy.gasUsed) / deployMainnet : null,
    });

    const meanPrices = { tokenUsd: mean(days.map((d) => d.tokenUsd)), ptax: mean(days.map((d) => d.ptax)) };
    const points = [];
    for (const row of rows.filter((r) => r.network === name)) {
      const point = cost24hRow(row, meanPrices);
      if (point) points.push({ kind, ...point });
    }
    cost24h.push(...points);
    stats.push(...statsRows(name, rows, points).map((row) => ({ kind, ...row })));
    counts.push({ kind, ...runCounts(name, rows) });
  }

  const timestamp = runIdFromDate(startedAt);
  const meta = {
    ...collectRunMetadata({ run: values.run, history: values.history }, startedAt),
    historyWindow: { from: history[0]?.date, to: history.at(-1)?.date },
    scenarios,
    blobSummary: blobSummary(history.filter((day) => day.kind === "ethereum")),
  };
  const outputs: [string, Record<string, unknown>[]][] = [
    ["cross-chain-summary", summary],
    ["cross-chain-annual", annual],
    ["cross-chain-per-record", perRecord],
    ["cross-chain-deploy", deployRows],
    ["cross-chain-gas", gasRows],
    ["cross-chain-cost-24h", cost24h],
    ["cross-chain-stats", stats],
    ["cross-chain-counts", counts],
  ];
  for (const [prefix, data] of outputs) {
    if (data.length === 0) {
      console.warn(`${prefix}: nothing to write`);
      continue;
    }
    const { jsonPath } = await writeResults(prefix, data, RESULTS_DIR, meta, timestamp);
    console.log(`Wrote ${jsonPath}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
