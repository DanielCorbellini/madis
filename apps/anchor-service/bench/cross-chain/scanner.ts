import type { HistoryDay } from "./history.ts";
import { percentile } from "./stats.ts";
import type { NetworkKind } from "./types.ts";

export type Statistic = "mean" | "median";

/** A history day whose gas price is the block explorer's daily average. */
export interface ScannerDay extends HistoryDay {
  gasPriceSource: "scanner";
  statistic: Statistic;
  /** Arbitrum only: the day's L1 charge in wei, for an anchoring and for the deploy. */
  l1FeeWei: string | null;
  l1FeeDeployWei: string | null;
}

/** The day's mean L1 charges in wei, keyed by YYYY-MM-DD. */
export type L1Fees = Map<string, { l1FeeWei: string; l1FeeDeployWei: string }>;

/** One saved history reading (`cross-chain-history-progress-*.json`). */
export interface ProgressSample {
  kind: string;
  time: number;
  gasPriceWei: string;
  l1GasUsed: string | null;
  l1GasUsedDeploy: string | null;
}

/**
 * Arbitrum's L1 charge at each saved reading. NodeInterface expresses that
 * charge in L2 gas at the same block's base fee, so multiplying by that base
 * fee gives back the charge in wei, whatever the L2 gas price is elsewhere.
 */
export function l1FeeSamples(progress: Record<string, ProgressSample>) {
  return Object.values(progress)
    .filter((sample) => sample.kind === "arbitrum")
    .sort((a, b) => a.time - b.time)
    .map((sample) => {
      const baseFee = BigInt(sample.gasPriceWei);
      const l1 = BigInt(sample.l1GasUsed ?? 0);
      const l1Deploy = BigInt(sample.l1GasUsedDeploy ?? 0);
      const iso = new Date(sample.time * 1000).toISOString();
      return {
        date: iso.slice(0, 10),
        timeUtc: iso,
        baseFeeWei: baseFee.toString(),
        l1GasUsed: l1.toString(),
        l1FeeWei: (l1 * baseFee).toString(),
        l1GasUsedDeploy: l1Deploy.toString(),
        l1FeeDeployWei: (l1Deploy * baseFee).toString(),
      };
    });
}

/** Each day's mean L1 charge: the mean of its readings' charges, each priced at its own block. */
export function dailyL1Fees(samples: ReturnType<typeof l1FeeSamples>): L1Fees {
  const byDay = new Map<string, typeof samples>();
  for (const sample of samples) {
    byDay.set(sample.date, [...(byDay.get(sample.date) ?? []), sample]);
  }
  const fees: L1Fees = new Map();
  for (const [date, own] of byDay) {
    const meanOf = (field: "l1FeeWei" | "l1FeeDeployWei") =>
      (own.reduce((sum, s) => sum + BigInt(s[field]), 0n) / BigInt(own.length)).toString();
    fees.set(date, { l1FeeWei: meanOf("l1FeeWei"), l1FeeDeployWei: meanOf("l1FeeDeployWei") });
  }
  return fees;
}

/** The explorers' "average gas price" export: `"M/D/YYYY","unix","wei"`, keyed by YYYY-MM-DD. */
export function parseScannerCsv(text: string): Map<string, string> {
  const prices = new Map<string, string>();
  for (const line of text.replace(/^﻿/, "").trim().split("\n").slice(1)) {
    const [date, , wei] = line.split(",").map((cell) => cell.trim().replace(/"/g, ""));
    const [month, day, year] = date.split("/");
    prices.set(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`, wei);
  }
  return prices;
}

/**
 * The history with each day's gas price swapped for the explorer's: token
 * price, PTAX and Arbitrum's L1 gas stay as fetched, and Arbitrum days gain
 * their L1 charge in wei (priced at the readings' own base fee, not the
 * explorer's). `statistic` tells the projection how to summarize the daily
 * costs (the rows are the same for both).
 */
export function buildScannerDays(
  history: HistoryDay[],
  prices: Record<NetworkKind, Map<string, string>>,
  statistic: Statistic,
  l1Fees: L1Fees,
): ScannerDay[] {
  return history.map((day) => {
    const gasPriceWei = prices[day.kind].get(day.date);
    if (gasPriceWei === undefined) {
      throw new Error(`the ${day.kind} explorer export has no price for ${day.date}`);
    }
    let fees = { l1FeeWei: null as string | null, l1FeeDeployWei: null as string | null };
    if (day.kind === "arbitrum") {
      const own = l1Fees.get(day.date);
      if (!own) throw new Error(`no Arbitrum L1 charge for ${day.date}`);
      fees = own;
    }
    return { ...day, gasPriceWei, gasPriceSource: "scanner", statistic, ...fees };
  });
}

/** Each network's mean and median gas price over the period, to check against the exports by hand. */
export function periodStatistics(days: HistoryDay[]) {
  const byKind: Record<string, { days: number; meanWei: number; medianWei: number }> = {};
  for (const kind of new Set(days.map((day) => day.kind))) {
    const values = days.filter((day) => day.kind === kind).map((day) => Number(day.gasPriceWei));
    byKind[kind] = {
      days: values.length,
      meanWei: values.reduce((sum, v) => sum + v, 0) / values.length,
      medianWei: percentile(values, 0.5),
    };
  }
  return byKind;
}
