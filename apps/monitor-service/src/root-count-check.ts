export interface RootCountCheck {
  onChainRootCount: number;
  trackedBatchCount: number;
  matches: boolean;
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
