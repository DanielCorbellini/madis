import type { ReconcileSummary } from "./reconcile.ts";

export type CycleStatus =
  | "confirmed"
  | "submitted"
  | "failed"
  | "nothing-to-anchor"
  | "aborted";

/**
 * One chunk's outcome within a cycle. `status: "pending"` only occurs when
 * shutdown was requested right after this batch persisted, before it could
 * ever be submitted — see `runCycle`'s per-chunk abort checkpoint.
 */
export interface BatchOutcome {
  root: string;
  size: number;
  status: "confirmed" | "submitted" | "failed" | "pending";
  txHash: string | null;
  blockNumber: number | null;
  gasUsed: string | null;
  gasPrice: string | null;
}

export interface CycleSummary {
  cycle: number;
  reconciled: ReconcileSummary;
  scanned: number;
  rejected: number;
  batched: number;
  batches: BatchOutcome[];
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
  batches: BatchOutcome[];
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
