export interface AnchorCountCheck {
  onChainSize: number;
  anchoredCount: number;
  complete: boolean;
}

/**
 * Compares a batch's on-chain size (ground truth, read via the contract's
 * `getBatchInfo`) against how many `anchor_records` rows currently exist
 * for it in Postgres. Any mismatch — not only "fewer than" — means the
 * two disagree about batch membership: a previously-anchored row's
 * `anchor_records` entry was deleted (or, anomalously, an extra one
 * appeared). This is the one gap a per-record proof loop can never
 * notice on its own, since it only ever visits rows that are still there.
 */
export function checkAnchorCount(
  onChainSize: number,
  anchoredCount: number,
): AnchorCountCheck {
  return {
    onChainSize,
    anchoredCount,
    complete: anchoredCount === onChainSize,
  };
}
