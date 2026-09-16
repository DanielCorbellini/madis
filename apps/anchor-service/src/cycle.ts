import type { Logger } from "service-runtime";
import type { AnchorEntry } from "./batch-repository.ts";
import { RevertedTransactionError, type BlockRef } from "./chain-confirm.ts";
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

  /**
   * Get all unanchored records and validate them. Those that pass validation are added to the Merkle tree,
   * those that fail are logged and an alert is inserted.
   */
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

export type SubmitAndConfirmResult =
  | {
      status: "confirmed";
      block: BlockRef;
      txHash: string | null;
      stageMs: { submit: number; confirm: number };
    }
  | {
      status: "submitted";
      txHash: string;
      stageMs: { submit: number; confirm: number };
    }
  | {
      status: "failed";
      errorMessage: string;
      stageMs: { submit: number; confirm: number };
    };

/**
 * Submits a persisted batch's root and waits for confirmations
 * before this same cycle ends. A `RevertedTransactionError` from
 * `awaitConfirmation` is the one deterministic outcome, everything
 * else (timeout, network failure) leaves the batch `submitted` rather than
 * guessing at its fate; Phase 0 reconciles it next cycle.
 */
export async function submitAndConfirmBatch(
  deps: Pick<
    CycleDeps,
    | "findRootOnChain"
    | "submitRoot"
    | "awaitConfirmation"
    | "markSubmitted"
    | "markConfirmed"
    | "markFailed"
  >,
  batch: { id: number; merkleRoot: string; size: number },
  options: { confirmations: number; confirmationTimeoutMs: number },
  logger: Logger,
): Promise<SubmitAndConfirmResult> {
  const submitStart = performance.now();
  const alreadyOnChain = await deps.findRootOnChain(batch.merkleRoot);

  /**
   * Check if the root exists to avoid unnecessary send.
   * This rarely happens, it's a safeguard against racing
   * conditions across multiple instances of the anchor-service.
   */
  if (alreadyOnChain) {
    await deps.markConfirmed(batch.id, alreadyOnChain);

    return {
      status: "confirmed",
      block: alreadyOnChain,
      txHash: null,
      stageMs: { submit: performance.now() - submitStart, confirm: 0 },
    };
  }

  let result: SubmitResult;

  /**
   * If the root is not already on-chain, attempt to submit it.
   * If submission fails, mark the batch as failed and return the error.
   */
  try {
    result = await deps.submitRoot(batch.merkleRoot, batch.size);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(
      { batchId: batch.id, err: message },
      "failed to submit new batch",
    );

    await deps.markFailed(batch.id, message);
    return {
      status: "failed",
      errorMessage: message,
      stageMs: { submit: performance.now() - submitStart, confirm: 0 },
    };
  }

  /**
   * Safeguard against racing conditions after the submission of a root
   */
  if (result.status === "already-on-chain") {
    const block = await deps.findRootOnChain(batch.merkleRoot);

    /**
     * This should never happen, but if it does,
     * log an error and mark the batch as failed.
     * This is a safeguard against inconsistencies in the RPC provider.
     */
    if (!block) {
      const message = `addMerkleRoot reported RootAlreadyExists for batch ${batch.id} but the root is not findable on-chain`;
      logger.error({ batchId: batch.id }, message);
      await deps.markFailed(batch.id, message);
      return {
        status: "failed",
        errorMessage: message,
        stageMs: { submit: performance.now() - submitStart, confirm: 0 },
      };
    }

    await deps.markConfirmed(batch.id, block);
    return {
      status: "confirmed",
      block,
      txHash: null,
      stageMs: { submit: performance.now() - submitStart, confirm: 0 },
    };
  }

  const submitMs = performance.now() - submitStart;
  const txHash = result.tx.hash;
  await deps.markSubmitted(batch.id, txHash);

  const confirmStart = performance.now();
  /**
   * Get confirmation for the submitted transaction.
   * If the transaction is reverted, mark the batch as failed.
   */
  try {
    const block = await deps.awaitConfirmation(
      txHash,
      options.confirmations,
      options.confirmationTimeoutMs,
    );

    await deps.markConfirmed(batch.id, block);
    return {
      status: "confirmed",
      block,
      txHash,
      stageMs: { submit: submitMs, confirm: performance.now() - confirmStart },
    };
  } catch (error) {
    const confirmMs = performance.now() - confirmStart;

    if (error instanceof RevertedTransactionError) {
      const message = `transaction ${txHash} was mined but reverted`;
      logger.warn({ batchId: batch.id, txHash }, message);
      await deps.markFailed(batch.id, message);
      return {
        status: "failed",
        errorMessage: message,
        stageMs: { submit: submitMs, confirm: confirmMs },
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      { batchId: batch.id, txHash, err: message },
      "confirmation wait failed; batch remains 'submitted' for Phase 0 to reconcile",
    );

    return {
      status: "submitted",
      txHash,
      stageMs: { submit: submitMs, confirm: confirmMs },
    };
  }
}
