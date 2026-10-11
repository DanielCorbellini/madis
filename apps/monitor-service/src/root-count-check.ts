import type { BatchStatus } from "./batch-selection-repository.ts";

export interface RootCountCheck {
  onChainRootCount: number;
  trackedBatchCount: number;
  matches: boolean;
}

export interface AnchoredBatch {
  batchId: number;
  root: string;
}

/**
 * Compares the total number of roots the contract has ever accepted
 * against how many `batches` rows Postgres currently counts as
 * on-chain-or-on-the-way ('confirmed' + 'submitted'). A mismatch means
 * some batch that once achieved (or was working toward) on-chain success
 * no longer shows up in either status — its row was deleted, or its
 * `status` was edited to something excluded from this count. This is the
 * detection mechanism for whole-batch tampering that a full rescan of
 * `'confirmed'` rows can never notice on its own, since a rescan only
 * ever visits batches still tagged `'confirmed'`.
 */
export function checkRootCount(
  onChainRootCount: number,
  trackedBatchCount: number,
): RootCountCheck {
  return {
    onChainRootCount,
    trackedBatchCount,
    matches: onChainRootCount === trackedBatchCount,
  };
}

export interface OnChainBatchClassification {
  /** On-chain batches with no `batches` row in Postgres at all. */
  missing: AnchoredBatch[];
  /** On-chain batches whose row is `pending`/`failed`: a status that cannot be true for a batch the chain accepted. */
  inconsistent: Array<AnchoredBatch & { status: BatchStatus }>;
  /** Every on-chain batch id that has a row, whatever its status, in on-chain order. */
  auditable: number[];
}

/**
 * Sorts the chain's own `(batchId, root)` list against what Postgres says about
 * those same ids. The chain decides which batches exist and so which must be
 * audited; Postgres's `status` column — attacker-writable — only decides how a
 * mismatch is described, never whether a batch is audited. A batch the chain
 * accepted is genuine in whatever state its row claims: `confirmed` and
 * `submitted` are expected (the latter just hasn't been reconciled yet), while
 * a missing row or a `pending`/`failed` one is tampering evidence. Rows for ids
 * that are not on-chain are out of scope here (the opposite anomaly, handled by
 * the confirmed/stale-submitted checks).
 */
export function classifyOnChainBatches(
  onChain: AnchoredBatch[],
  statuses: Map<number, BatchStatus>,
): OnChainBatchClassification {
  const result: OnChainBatchClassification = {
    missing: [],
    inconsistent: [],
    auditable: [],
  };

  for (const batch of onChain) {
    const status = statuses.get(batch.batchId);

    if (status === undefined) {
      result.missing.push(batch);
      continue;
    }

    result.auditable.push(batch.batchId);

    if (status === "pending" || status === "failed") {
      result.inconsistent.push({ ...batch, status });
    }
  }

  return result;
}
