import type { Tick } from "./types.ts";

/** Ticks at `start + i × interval` for every tick before `start + duration`. */
export function buildSchedule(startMs: number, intervalMs: number, durationMs: number): Tick[] {
  const ticks: Tick[] = [];
  for (let index = 0; startMs + index * intervalMs < startMs + durationMs; index++) {
    ticks.push({ index, at: startMs + index * intervalMs });
  }
  return ticks;
}

/**
 * Splits the ticks not yet done into missed (past their grace period, e.g.
 * while the machine was down) and upcoming. The window never moves: missed
 * ticks are recorded, not run late.
 */
export function classifyTicks(
  schedule: Tick[],
  doneIndexes: Set<number>,
  nowMs: number,
  graceMs: number,
): { missed: Tick[]; upcoming: Tick[] } {
  const pending = schedule.filter((tick) => !doneIndexes.has(tick.index));
  return {
    missed: pending.filter((tick) => tick.at + graceMs < nowMs),
    upcoming: pending.filter((tick) => tick.at + graceMs >= nowMs),
  };
}

/** The `writeResults` timestamp format, so `plot.py` finds the run's files. */
export function runIdFromDate(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Plan for `--run`: every tick that had started before the interruption
 * (`at <= now`) is never re-run, since an anchoring may already have been
 * sent with its batch id; its (tick, network) pairs without a saved row
 * become missed. Only ticks still in the future are upcoming.
 */
export function resumePlan(
  schedule: Tick[],
  saved: { tick: number; network: string }[],
  networks: string[],
  nowMs: number,
): { missed: { tick: number; network: string }[]; upcoming: Tick[] } {
  const done = new Set(saved.map((row) => `${row.tick}:${row.network}`));
  const missed = schedule
    .filter((tick) => tick.at <= nowMs)
    .flatMap((tick) => networks.map((network) => ({ tick: tick.index, network })))
    .filter((pair) => !done.has(`${pair.tick}:${pair.network}`));
  return { missed, upcoming: schedule.filter((tick) => tick.at > nowMs) };
}

/** A tick past its grace period, e.g. reached only after the machine woke from a suspend. */
export function isOverdue(tick: Tick, nowMs: number, graceMs: number): boolean {
  return nowMs > tick.at + graceMs;
}
