import type { NetworkKind } from "./types.ts";

const DAY_S = 86_400;
const SAMPLE_HOURS = [0, 6, 12, 18];

/** Epoch seconds at 00/06/12/18 UTC for each of the `days` days before `endDate` (exclusive, YYYY-MM-DD). */
export function sampleTimes(endDate: string, days: number): number[] {
  const end = Date.parse(`${endDate}T00:00:00Z`) / 1000;
  const times: number[] = [];
  for (let d = days; d >= 1; d--) {
    for (const hour of SAMPLE_HOURS) {
      times.push(end - d * DAY_S + hour * 3600);
    }
  }
  return times;
}

/**
 * The last block whose timestamp is ≤ `target`, between `from` and `latest`.
 * Interpolation search: each probe guesses from the timestamps of the current
 * bounds, so a steady block time takes a handful of calls instead of a binary
 * search's ~25 (RPC credits are the constraint). Starting from the previous
 * sample's block matters: a chain's early blocks (Arbitrum's especially) have
 * a very different pace, which misleads a guess made from block 0.
 */
export async function findBlockAtTime(
  getTimestamp: (block: number) => Promise<number>,
  latest: number,
  target: number,
  from = 0,
): Promise<number> {
  let lo = from;
  let hi = latest;
  let tLo = await getTimestamp(lo);
  if (target < tLo) {
    if (from === 0) throw new Error(`target ${target} is before block 0`);
    return findBlockAtTime(getTimestamp, latest, target, 0);
  }
  let tHi = await getTimestamp(hi);
  if (target >= tHi) return hi;

  // Invariant: tLo ≤ target < tHi.
  while (hi - lo > 1) {
    const guess = lo + Math.floor(((target - tLo) / (tHi - tLo)) * (hi - lo));
    const probe = Math.min(hi - 1, Math.max(lo + 1, guess));
    const t = await getTimestamp(probe);
    if (t <= target) {
      lo = probe;
      tLo = t;
    } else {
      hi = probe;
      tHi = t;
    }
    // Interpolation can creep one block at a time near an irregular gap; bisect when a probe gains little.
    if (hi - lo > 1 && (probe === lo + 1 || probe === hi - 1)) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const tm = await getTimestamp(mid);
      if (tm <= target) {
        lo = mid;
        tLo = tm;
      } else {
        hi = mid;
        tHi = tm;
      }
    }
  }
  return lo;
}

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** CoinGecko `market_chart/range`: the last price of each UTC day. */
export function parseCoinGecko(json: { prices: [number, number][] }): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const [ms, price] of [...json.prices].sort((a, b) => a[0] - b[0])) {
    byDay.set(utcDate(ms), price);
  }
  return byDay;
}

/** Banco Central's `CotacaoDolarPeriodo`: the last sell quote of each day. */
export function parsePtax(json: { value: { cotacaoVenda: number; dataHoraCotacao: string }[] }): Map<string, number> {
  const byDay = new Map<string, number>();
  const quotes = [...json.value].sort((a, b) => a.dataHoraCotacao.localeCompare(b.dataHoraCotacao));
  for (const quote of quotes) {
    byDay.set(quote.dataHoraCotacao.slice(0, 10), quote.cotacaoVenda);
  }
  return byDay;
}

/**
 * One value per date: a date without one (weekends and holidays for PTAX, a
 * missing day for prices) takes the latest earlier value.
 */
export function fillForward(
  dates: string[],
  series: Map<string, number>,
): { values: Map<string, number>; filled: number } {
  const known = [...series].sort((a, b) => a[0].localeCompare(b[0]));
  const values = new Map<string, number>();
  let filled = 0;
  for (const date of dates) {
    const exact = series.get(date);
    if (exact !== undefined) {
      values.set(date, exact);
      continue;
    }
    const earlier = known.filter(([d]) => d < date).at(-1);
    if (!earlier) throw new Error(`no value on or before ${date}`);
    values.set(date, earlier[1]);
    filled++;
  }
  return { values, filled };
}

/** One mainnet sample at one of the day's sample times. */
export interface HistorySample {
  kind: NetworkKind;
  /** Epoch seconds. */
  time: number;
  /** What a sender pays per gas: base fee + p50 tip (Arbitrum: NodeInterface's base fee). */
  gasPriceWei: bigint;
  /** Ethereum only. */
  blobBaseFeeWei: bigint | null;
  /** Arbitrum only: L1 gas (in L2 units) for the anchoring calldata and for the deploy. */
  l1GasUsed: bigint | null;
  l1GasUsedDeploy: bigint | null;
}

export interface HistoryDay {
  date: string;
  kind: NetworkKind;
  gasPriceWei: string;
  samples: number;
  l1GasUsed: string | null;
  l1GasUsedDeploy: string | null;
  blobBaseFeeWei: string | null;
  tokenUsd: number;
  ptax: number;
  [key: string]: string | number | null;
}

const meanOf = (values: bigint[]): string | null =>
  values.length === 0 ? null : (values.reduce((sum, v) => sum + v, 0n) / BigInt(values.length)).toString();

/**
 * One row per (kind, date): the mean of that day's samples, with the token's
 * USD price (ETH for Ethereum and Arbitrum, POL for Polygon) and the PTAX.
 * Prices and PTAX must already be filled forward over `dates`. A date with no
 * sample for a kind is dropped and counted.
 */
export function buildHistoryDays(
  samples: HistorySample[],
  dates: string[],
  prices: { eth: Map<string, number>; pol: Map<string, number> },
  ptax: Map<string, number>,
): { days: HistoryDay[]; droppedDays: number } {
  const kinds = [...new Set(samples.map((s) => s.kind))];
  const days: HistoryDay[] = [];
  let droppedDays = 0;
  for (const kind of kinds) {
    for (const date of dates) {
      const own = samples.filter((s) => s.kind === kind && utcDate(s.time * 1000) === date);
      if (own.length === 0) {
        droppedDays++;
        continue;
      }
      const token = (kind === "polygon" ? prices.pol : prices.eth).get(date);
      const rate = ptax.get(date);
      if (token === undefined || rate === undefined) {
        throw new Error(`missing token price or PTAX for ${date}`);
      }
      days.push({
        date,
        kind,
        gasPriceWei: meanOf(own.map((s) => s.gasPriceWei))!,
        samples: own.length,
        l1GasUsed: meanOf(own.flatMap((s) => (s.l1GasUsed === null ? [] : [s.l1GasUsed]))),
        l1GasUsedDeploy: meanOf(own.flatMap((s) => (s.l1GasUsedDeploy === null ? [] : [s.l1GasUsedDeploy]))),
        blobBaseFeeWei: meanOf(own.flatMap((s) => (s.blobBaseFeeWei === null ? [] : [s.blobBaseFeeWei]))),
        tokenUsd: token,
        ptax: rate,
      });
    }
  }
  return { days, droppedDays };
}
