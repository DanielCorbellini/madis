import type { Pool } from "pg";
import type { Logger } from "service-runtime";
import { recordSignatureMismatch as dbRecordSignatureMismatch } from "./alerts.ts";
import {
  type AnchorEntry,
  markConfirmed as dbMarkConfirmed,
  markFailed as dbMarkFailed,
  markSubmitted as dbMarkSubmitted,
  persistBatch as dbPersistBatch,
} from "./batch-repository.ts";
import {
  type BlockRef,
  awaitConfirmation as chainAwaitConfirmation,
  findRootOnChain as chainFindRootOnChain,
  RevertedTransactionError,
} from "./chain-confirm.ts";
import {
  submitRoot as chainSubmitRoot,
  type SubmitResult,
} from "./chain-submit.ts";
import type { ChainClient, ChainProvider } from "./chain.ts";
import type { AnchorConfig } from "./config.ts";
import { buildCycleSummary, type CycleSummary } from "./metrics.ts";
import {
  createReconcileDeps,
  reconcileBatches,
  type ReconcileSummary,
} from "./reconcile.ts";
import type { AnchorableRecord } from "./record.ts";
import { streamUnanchoredRecords as dbStreamUnanchoredRecords } from "./records-source.ts";
import { snapshotMemory, timed } from "./timing.ts";
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
 * 1. Get every un-anchored record
 * 2. Validates each one (signature + whitelist)
 * 3. Alerts the ones that fails
 * 4. Build a Merkle Tree from the valid ones
 *
 * Returns `null` ("nothing to anchor") if zero records passed validation;
 * never calls `buildAnchorTree` with an empty array.
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

export interface CycleOptions {
  cycleNumber: number;
  whitelistedAddresses: string[];
  confirmations: number;
  confirmationTimeoutMs: number;
}

/**
 * Sequences one full anchoring cycle:
 * 1. Phase 0 (reconcile in-flight batches),
 * 2. Phases 1–3 (collect a new valid batch, or "nothing to anchor"),
 * 3. Phase 4 (persist),
 * 4. Phases 5–6 (submit + await confirmation)
 * 5. Phase 7 (summary).
 */
export async function runCycle(
  deps: CycleDeps,
  options: CycleOptions,
  logger: Logger,
  shouldAbort: () => boolean = () => false,
): Promise<CycleSummary> {
  const cycleStart = performance.now();

  // Phase 0
  const { result: reconciled, ms: reconcileMs } = await timed(() =>
    deps.reconcileBatches(),
  );

  // Phase 1-3
  const { result: collected, ms: collectMs } = await timed(() =>
    collectValidBatch(deps, options.whitelistedAddresses, logger),
  );

  if (!collected) {
    logger.info({ cycle: options.cycleNumber }, "nothing to anchor this cycle");

    return buildCycleSummary({
      cycle: options.cycleNumber,
      reconciled,
      scanned: 0,
      rejected: 0,
      batched: 0,
      root: null,
      txHash: null,
      blockNumber: null,
      status: "nothing-to-anchor",
      durationMs: performance.now() - cycleStart,
      stageMs: { reconcile: reconcileMs, collect: collectMs },
      peakRssBytes: snapshotMemory().rssBytes,
    });
  }

  // Phase 4
  const { result: batchId, ms: persistMs } = await timed(() =>
    deps.persistBatch({ root: collected.root, entries: collected.entries }),
  );

  if (shouldAbort()) {
    logger.warn(
      { cycle: options.cycleNumber, batchId },
      "shutdown requested — leaving batch 'pending' for the next startup's Phase 0 to submit",
    );

    return buildCycleSummary({
      cycle: options.cycleNumber,
      reconciled,
      scanned: collected.scannedCount,
      rejected: collected.rejectedCount,
      batched: collected.entries.length,
      root: collected.root,
      txHash: null,
      blockNumber: null,
      status: "aborted",
      durationMs: performance.now() - cycleStart,
      stageMs: {
        reconcile: reconcileMs,
        ...collected.stageMs,
        persist: persistMs,
      },
      peakRssBytes: snapshotMemory().rssBytes,
    });
  }

  // Phase 5-6
  const submitResult = await submitAndConfirmBatch(
    deps,
    { id: batchId, merkleRoot: collected.root, size: collected.size },
    {
      confirmations: options.confirmations,
      confirmationTimeoutMs: options.confirmationTimeoutMs,
    },
    logger,
  );

  // Phase 7
  const summary = buildCycleSummary({
    cycle: options.cycleNumber,
    reconciled,
    scanned: collected.scannedCount,
    rejected: collected.rejectedCount,
    batched: collected.entries.length,
    root: collected.root,
    txHash: submitResult.status === "failed" ? null : submitResult.txHash,
    blockNumber:
      submitResult.status === "confirmed" ? submitResult.block.number : null,
    status: submitResult.status,
    durationMs: performance.now() - cycleStart,
    stageMs: {
      reconcile: reconcileMs,
      ...collected.stageMs,
      persist: persistMs,
      ...submitResult.stageMs,
    },
    peakRssBytes: snapshotMemory().rssBytes,
  });

  logger.info(summary, "cycle complete");
  return summary;
}

/**
 * Creates the dependencies for a single anchoring cycle, including the reconciliation and submission logic.
 */
export function createCycleDeps(
  chain: ChainClient,
  pool: Pool,
  config: Pick<
    AnchorConfig,
    | "confirmations"
    | "confirmationTimeoutMs"
    | "maxFeeGwei"
    | "txRetries"
    | "retryAlertThreshold"
  >,
  logger: Logger,
): CycleDeps {
  const reconcileDeps = createReconcileDeps(chain, pool, {
    retries: config.txRetries,
    maxFeeGwei: config.maxFeeGwei,
  });

  const provider: Pick<ChainProvider, "waitForTransaction" | "getBlock"> = {
    getBlock: (blockNumber) => chain.provider.getBlock(blockNumber),
    waitForTransaction: async (hash, confirms, timeout) => {
      const receipt = await chain.provider.waitForTransaction(
        hash,
        confirms,
        timeout,
      );
      if (!receipt) return null;
      return { status: receipt.status ?? 0, blockNumber: receipt.blockNumber };
    },
  };

  return {
    reconcileBatches: () =>
      reconcileBatches(
        reconcileDeps,
        {
          confirmations: config.confirmations,
          retryAlertThreshold: config.retryAlertThreshold,
        },
        logger,
      ),
    streamUnanchoredRecords: () => dbStreamUnanchoredRecords(pool),
    recordSignatureMismatch: (recordId, details) =>
      dbRecordSignatureMismatch(pool, recordId, details),
    persistBatch: (batch) => dbPersistBatch(pool, batch),
    findRootOnChain: (root) =>
      chainFindRootOnChain(chain.contract, chain.provider, root),
    submitRoot: (root, size) =>
      chainSubmitRoot(chain.contract, chain.provider, root, size, {
        retries: config.txRetries,
        maxFeeGwei: config.maxFeeGwei,
      }),
    awaitConfirmation: (txHash, confirmations, timeoutMs) =>
      chainAwaitConfirmation(provider, txHash, confirmations, timeoutMs),
    markSubmitted: (batchId, txHash) => dbMarkSubmitted(pool, batchId, txHash),
    markConfirmed: (batchId, block) => dbMarkConfirmed(pool, batchId, block),
    markFailed: (batchId, errorMessage) =>
      dbMarkFailed(pool, batchId, errorMessage),
  };
}
