import type { HistoryDay } from "./history.ts";
import { percentile } from "./stats.ts";
import type { NetworkKind } from "./types.ts";

export type Statistic = "mean" | "median";

/** A history day whose gas price is the block explorer's daily average. */
export interface ScannerDay extends HistoryDay {
  gasPriceSource: "scanner";
  statistic: Statistic;
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
 * price, PTAX and Arbitrum's L1 gas stay as fetched. `statistic` tells the
 * projection how to summarize the daily costs (the rows are the same for both).
 */
export function buildScannerDays(
  history: HistoryDay[],
  prices: Record<NetworkKind, Map<string, string>>,
  statistic: Statistic,
): ScannerDay[] {
  return history.map((day) => {
    const gasPriceWei = prices[day.kind].get(day.date);
    if (gasPriceWei === undefined) {
      throw new Error(`the ${day.kind} explorer export has no price for ${day.date}`);
    }
    return { ...day, gasPriceWei, gasPriceSource: "scanner", statistic };
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
