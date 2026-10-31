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
