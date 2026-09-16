import type { Logger } from "service-runtime";
import type { AnchorEntry } from "./batch-repository.ts";
import type { BlockRef } from "./chain-confirm.ts";
import type { SubmitResult } from "./chain-submit.ts";
import type { ReconcileSummary } from "./reconcile.ts";
import type { AnchorableRecord } from "./record.ts";
import { buildAnchorTree, type LeafEntry } from "./tree.ts";
import { validateRecord } from "./validation.ts";

export interface CycleDeps {
  reconcileBatches(): Promise<ReconcileSummary>;
  streamUnanchoredRecords(): AsyncGenerator<AnchorableRecord>;
  recordSignatureMismatch(recordId: number, details: string): Promise<boolean>;
  persistBatch(batch: {
    root: string;
    entries: AnchorEntry[];
  }): Promise<number>;
  findRootOnChain(root: string): Promise<BlockRef | null>;
  submitRoot(root: string, size: number): Promise<SubmitResult>;
  awaitConfirmation(
    txHash: string,
    confirmations: number,
    timeoutMs: number,
  ): Promise<BlockRef>;
  markSubmitted(batchId: number, txHash: string): Promise<void>;
  markConfirmed(batchId: number, block: BlockRef): Promise<void>;
  markFailed(batchId: number, errorMessage: string): Promise<void>;
}

export interface CollectedBatch {
  root: string;
  size: number;
  entries: AnchorEntry[];
  scannedCount: number;
  rejectedCount: number;
  stageMs: { scanAndValidate: number; tree: number };
}

/**
 * Streams every un-anchored record, re-validates each one
 * (signature + whitelist), alerts and excludes the ones that fail, then
 * builds one Merkle tree from the rest.
 * Returns `null` ("nothing to anchor") if zero records passed validation;
 * never calls `buildAnchorTree` with an empty array (it throws).
 */
export async function collectValidBatch(
  deps: Pick<CycleDeps, "streamUnanchoredRecords" | "recordSignatureMismatch">,
  whitelistedAddresses: string[],
  logger: Logger,
): Promise<CollectedBatch | null> {
  const scanStart = performance.now();
  const leaves: LeafEntry[] = [];
  let scannedCount = 0;
  let rejectedCount = 0;

  // Get all unanchored records and validate them. Those that pass validation are added to the Merkle tree,
  // those that fail are logged and marked as rejected.
  for await (const record of deps.streamUnanchoredRecords()) {
    scannedCount++;
    const verdict = validateRecord(record, whitelistedAddresses);

    if (!verdict.ok) {
      rejectedCount++;

      logger.warn(
        { recordId: verdict.recordId, reason: verdict.reason },
        "record rejected during re-validation",
      );

      await deps.recordSignatureMismatch(verdict.recordId, verdict.reason);
      continue;
    }

    leaves.push({ recordId: verdict.recordId, leaf: verdict.leaf });
  }

  const scanAndValidateMs = performance.now() - scanStart;

  if (leaves.length === 0) {
    return null;
  }

  const treeStart = performance.now();
  const tree = buildAnchorTree(leaves);
  const treeMs = performance.now() - treeStart;

  return {
    root: tree.root,
    size: tree.entries.length,
    entries: tree.entries.map((entry) => ({
      recordId: entry.recordId,
      proof: entry.proof,
    })),
    scannedCount,
    rejectedCount,
    stageMs: { scanAndValidate: scanAndValidateMs, tree: treeMs },
  };
}
