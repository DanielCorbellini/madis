import type { ReconcileSummary } from "./reconcile.ts";

export type CycleStatus =
  | "confirmed"
  | "submitted"
  | "failed"
  | "nothing-to-anchor"
  | "aborted"
  | "duplicate-skipped";

/**
 * What happened to one batch of a cycle. `pending` means shutdown was
 * requested right after the batch persisted, so it was never submitted;
 * `duplicate-skipped` means its root already existed on-chain and nothing was
 * persisted for it.
 */
export interface BatchOutcome {
  root: string;
  size: number;
  status: "confirmed" | "submitted" | "failed" | "duplicate-skipped" | "pending";
  txHash: string | null;
  blockNumber: number | null;
  gasUsed: string | null;
  gasPrice: string | null;
  stageMs: Record<string, number>;
}

export interface CycleSummary {
  cycle: number;
  reconciled: ReconcileSummary;
  scanned: number;
  rejected: number;
  batched: number;
  root: string | null;
  txHash: string | null;
  blockNumber: number | null;
  gasUsed: string | null;
  gasPrice: string | null;
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
  root: string | null;
  txHash: string | null;
  blockNumber: number | null;
  gasUsed: string | null;
  gasPrice: string | null;
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
    batches: input.batches.map((batch) => ({
      ...batch,
      stageMs: Object.fromEntries(
        Object.entries(batch.stageMs).map(([stage, ms]) => [
          stage,
          Math.round(ms),
        ]),
      ),
    })),
    durationMs: Math.round(input.durationMs),
    stageMs: roundedStageMs,
  };
}
