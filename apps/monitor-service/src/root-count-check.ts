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

/**
 * Names the batches behind a root-count mismatch: the on-chain
 * `(batchId, root)` pairs whose id is not among the ids Postgres currently
 * tracks as confirmed/submitted. The chain supplies the ids and roots, so a
 * deleted `batches` row can't hide itself; Postgres only supplies which ids it
 * still has. Tracked ids that aren't on-chain are not "missing" — they are the
 * opposite anomaly (an over-count) and stay with the generic count alert.
 */
export function findMissingBatches(
  onChain: AnchoredBatch[],
  trackedBatchIds: number[],
): AnchoredBatch[] {
  const tracked = new Set(trackedBatchIds);
  return onChain.filter((batch) => !tracked.has(batch.batchId));
}
