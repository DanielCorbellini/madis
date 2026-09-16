import type { ReconcileSummary } from "./reconcile.ts";

export type CycleStatus =
  | "confirmed"
  | "submitted"
  | "failed"
  | "nothing-to-anchor";

export interface CycleSummary {
  cycle: number;
  reconciled: ReconcileSummary;
  scanned: number;
  rejected: number;
  batched: number;
  root: string | null;
  txHash: string | null;
  blockNumber: number | null;
  status: CycleStatus;
  durationMs: number;
  stageMs: Record<string, number>;
  peakRssBytes: number;
}

/**
 * Assembles the one structured log line emitted at the end of every cycle.
 * Rounds every millisecond figure to an integer
 */
export function buildCycleSummary(input: {
  cycle: number;
  reconciled: ReconcileSummary;
  scanned: number;
  rejected: number;
  batched: number;
  root: string | null;
  txHash: string | null;
  blockNumber: number | null;
  status: CycleStatus;
  durationMs: number;
  stageMs: Record<string, number>;
  peakRssBytes: number;
}): CycleSummary {
  const roundedStageMs = Object.fromEntries(
    Object.entries(input.stageMs).map(([stage, ms]) => [stage, Math.round(ms)]),
  );

  return {
    ...input,
    durationMs: Math.round(input.durationMs),
    stageMs: roundedStageMs,
  };
}
