import { oneTwoFive } from "service-runtime";
import type { HistoryDay } from "./history.ts";
import { percentile, summarize } from "./stats.ts";
import type { CrossChainRow, NetworkKind } from "./types.ts";

export interface Cost {
  usd: number;
  brl: number;
}

export interface Projection {
  mean: Cost;
  p10: Cost;
  p90: Cost;
  days: number;
}

/** Mainnet gas of one anchoring: total, and the L2 part (total minus Arbitrum's L1 part). */
export interface Gas {
  total: number;
  l2: number;
}

export const FREQUENCIES = [1, 8, 24, 96];
export const BASE_FREQUENCY = 8;
const WEI = 1e-18;

const TRUST_MODEL: Record<NetworkKind, string> = {
  ethereum: "Consenso da própria Ethereum (máxima descentralização)",
  polygon: "Conjunto próprio de validadores da Polygon",
  arbitrum: "Segurança da Ethereum via provas de fraude; sequenciador centralizado",
};

const anchored = (row: CrossChainRow) => row.status === "finalized" || row.status === "included";
const tried = (row: CrossChainRow) => row.status !== "missed" && row.status !== "skipped-busy";

/**
 * A failure caused by the RPC provider's rate limit (JSON-RPC -32005 or HTTP
 * 429), not by the network: the transaction never reached the chain, so it
 * is reported apart and kept out of the network's failure rate.
 */
const providerRefused = (row: CrossChainRow) =>
  row.status === "failed" && /too many requests|-32005|\b429\b/i.test(row.errorMessage ?? "");
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * One row's mainnet gas: the mainnet estimate corrected by the estimator's
 * margin measured on the testnet (actual ÷ estimate there), or null when the
 * row lacks what that needs.
 */
function rowMainnetGas(row: CrossChainRow): Gas | null {
  if (!row.gasUsed || !row.testnetGasEstimate || !row.mainnetGasEstimate) return null;
  const total = (Number(row.mainnetGasEstimate) * Number(row.gasUsed)) / Number(row.testnetGasEstimate);
  if (row.kind !== "arbitrum") return { total, l2: total };
  if (row.mainnetL1GasUsed === null) return null;
  return { total, l2: total - Number(row.mainnetL1GasUsed) };
}

/** Mean mainnet gas per anchoring over a network's usable rows (anchored, not warm-up), plus its mean testnet gas. */
export function meanGas(rows: CrossChainRow[], network: string): Gas & { testnet: number; n: number } {
  const usable = rows
    .filter((row) => row.network === network && anchored(row) && !row.warmUp)
    .map((row) => ({ row, gas: rowMainnetGas(row) }))
    .filter((entry): entry is { row: CrossChainRow; gas: Gas } => entry.gas !== null);
  return {
    total: mean(usable.map((e) => e.gas.total)),
    l2: mean(usable.map((e) => e.gas.l2)),
    testnet: mean(usable.map((e) => Number(e.row.gasUsed))),
    n: usable.length,
  };
}

/**
 * What one transaction with this gas would have cost on one historical day.
 * Arbitrum: (L2 gas + that day's L1 gas) × the day's L2 base fee, since the L1
 * part is charged in L2 gas units. Elsewhere: total gas × the day's price.
 */
export function dailyCost(
  day: HistoryDay,
  gas: Gas,
  l1Field: "l1GasUsed" | "l1GasUsedDeploy" = "l1GasUsed",
): Cost {
  const units = day.kind === "arbitrum" ? gas.l2 + Number(day[l1Field] ?? 0) : gas.total;
  const usd = units * Number(day.gasPriceWei) * WEI * day.tokenUsd;
  return { usd, brl: usd * day.ptax };
}

/** Mean (base scenario) and p10/p90 (optimistic/pessimistic) of the daily cost series. */
export function projectNetwork(days: HistoryDay[], gas: Gas): Projection {
  const costs = days.map((day) => dailyCost(day, gas));
  const usd = costs.map((c) => c.usd);
  const brl = costs.map((c) => c.brl);
  return {
    mean: { usd: mean(usd), brl: mean(brl) },
    p10: { usd: percentile(usd, 0.1), brl: percentile(brl, 0.1) },
    p90: { usd: percentile(usd, 0.9), brl: percentile(brl, 0.9) },
    days: days.length,
  };
}

export function annualRows(network: string, cost: Cost, frequencies = FREQUENCIES) {
  return frequencies.map((perDay) => ({
    network,
    perDay,
    annualUsd: cost.usd * perDay * 365,
    annualBrl: cost.brl * perDay * 365,
  }));
}

export function perRecordRows(network: string, cost: Cost, sizes = oneTwoFive(1000, 500_000)) {
  return sizes.map((batchSize) => ({
    network,
    batchSize,
    perRecordUsd: cost.usd / batchSize,
    perRecordBrl: cost.brl / batchSize,
  }));
}

/** The deploy's mainnet gas priced with the window's mean daily cost (Arbitrum: the deploy's own L1 part). */
export function deployCost(days: HistoryDay[], gas: Gas): Cost {
  const costs = days.map((day) => dailyCost(day, gas, "l1GasUsedDeploy"));
  return { usd: mean(costs.map((c) => c.usd)), brl: mean(costs.map((c) => c.brl)) };
}

/** The decision table's row: cost next to time to finality and trust model. */
export function summaryRow(network: string, kind: NetworkKind, projection: Projection, rows: CrossChainRow[]) {
  // The warm-up is recorded but kept out of every statistic (spec §4).
  const own = rows.filter((row) => row.network === network && !row.warmUp);
  const attempted = own.filter((row) => tried(row) && !providerRefused(row));
  const seconds = (values: (number | null)[]) =>
    values.filter((v): v is number => v !== null).map((v) => v / 1000);
  const inclusion = seconds(own.filter(anchored).map((row) => row.inclusionMs));
  const finality = seconds(own.filter((row) => row.status === "finalized").map((row) => row.finalityMs));
  return {
    network,
    costPerAnchoringBrl: projection.mean.brl,
    costPerAnchoringUsd: projection.mean.usd,
    annualBaseBrl: projection.mean.brl * BASE_FREQUENCY * 365,
    inclusionMedianS: inclusion.length ? percentile(inclusion, 0.5) : null,
    finalityMedianS: finality.length ? percentile(finality, 0.5) : null,
    finalityP95S: finality.length ? percentile(finality, 0.95) : null,
    failureRate: attempted.length ? attempted.filter((row) => row.status === "failed").length / attempted.length : null,
    rpcCallsMean: own.some(tried) ? mean(own.filter(tried).map((row) => row.rpcCallsTestnet + row.rpcCallsMainnet)) : null,
    trustModel: TRUST_MODEL[kind],
  };
}

/**
 * One anchoring's cost at the moment it was sent: its own mainnet gas × the
 * mainnet price snapshot × the window's mean token price and PTAX, so the
 * 24-hour chart shows only the intraday swing of the gas price.
 */
export function cost24hRow(row: CrossChainRow, meanPrices: { tokenUsd: number; ptax: number }) {
  const gas = rowMainnetGas(row);
  if (!gas || row.mainnetBaseFeeWei === null || row.mainnetTipWei === null) return null;
  const units = row.kind === "arbitrum" ? gas.l2 + Number(row.mainnetL1GasUsed ?? 0) : gas.total;
  const price = Number(row.mainnetBaseFeeWei) + Number(row.mainnetTipWei);
  const costUsd = units * price * WEI * meanPrices.tokenUsd;
  return {
    network: row.network,
    tick: row.tick,
    scheduledAt: row.scheduledAt,
    warmUp: row.warmUp,
    costUsd,
    costBrl: costUsd * meanPrices.ptax,
  };
}

/** Ethereum's blob base fee over the window, for the text's note on Arbitrum's L1 part. */
export function blobSummary(days: HistoryDay[]): { meanWei: number; p90Wei: number; maxWei: number } | null {
  const fees = days.flatMap((day) => (day.blobBaseFeeWei === null ? [] : [Number(day.blobBaseFeeWei)]));
  if (fees.length === 0) return null;
  return { meanWei: mean(fees), p90Wei: percentile(fees, 0.9), maxWei: Math.max(...fees) };
}

/**
 * Spec §6: n, mean, standard deviation, median, p95, min and max of the
 * inclusion time, the finality time (both in seconds) and the snapshot cost
 * per anchoring, warm-up excluded.
 */
export function statsRows(
  network: string,
  rows: CrossChainRow[],
  costPoints: { network: string; warmUp: boolean; costBrl: number }[],
) {
  const own = rows.filter((row) => row.network === network && !row.warmUp);
  const series: [string, number[]][] = [
    ["inclusionS", own.filter(anchored).flatMap((r) => (r.inclusionMs === null ? [] : [r.inclusionMs / 1000]))],
    ["finalityS", own.filter((r) => r.status === "finalized").flatMap((r) => (r.finalityMs === null ? [] : [r.finalityMs / 1000]))],
    ["costBrl", costPoints.filter((p) => p.network === network && !p.warmUp).map((p) => p.costBrl)],
  ];
  return series.filter(([, values]) => values.length > 0).map(([metric, values]) => ({ network, metric, ...summarize(values) }));
}

/**
 * Every outcome of the run for one network (network failures and provider
 * refusals apart), and the RPC calls of its attempted anchorings.
 */
export function runCounts(network: string, rows: CrossChainRow[]) {
  const own = rows.filter((row) => row.network === network);
  const count = (status: CrossChainRow["status"]) => own.filter((row) => row.status === status).length;
  const calls = own
    .filter((row) => row.status !== "missed" && row.status !== "skipped-busy")
    .map((row) => row.rpcCallsTestnet + row.rpcCallsMainnet);
  return {
    network,
    scheduled: own.length,
    warmUp: own.filter((row) => row.warmUp).length,
    finalized: count("finalized"),
    included: count("included"),
    failed: own.filter((row) => row.status === "failed" && !providerRefused(row)).length,
    providerRefused: own.filter(providerRefused).length,
    missed: count("missed"),
    skippedBusy: count("skipped-busy"),
    rpcCallsMean: calls.length ? mean(calls) : null,
    rpcCallsMax: calls.length ? Math.max(...calls) : null,
    rpcCallsTotal: calls.reduce((sum, n) => sum + n, 0),
  };
}
