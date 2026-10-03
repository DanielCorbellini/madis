import type { Pool } from "pg";
import {
  type AnchorableRecord,
  type Logger,
  snapshotMemory,
  timed,
} from "service-runtime";
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
import { type ChainClient, createProviderAdapter } from "./chain.ts";
import type { AnchorConfig } from "./config.ts";
import {
  type BatchOutcome,
  buildCycleSummary,
  type CycleStatus,
  type CycleSummary,
} from "./metrics.ts";
import {
  createReconcileDeps,
  reconcileBatches,
  type ReconcileSummary,
} from "./reconcile.ts";
import { streamUnanchoredRecords as dbStreamUnanchoredRecords } from "./records-source.ts";
import { buildAnchorTree, type LeafEntry } from "./tree.ts";
import { validateRecord } from "./validation.ts";

export interface CycleDeps {
  reconcileBatches(): Promise<ReconcileSummary>;
  records: {
    streamUnanchoredRecords(): AsyncGenerator<AnchorableRecord>;
  };
  chain: {
    findRootOnChain(root: string): Promise<BlockRef | null>;
    submitRoot(
      root: string,
      size: number,
      batchId: number,
    ): Promise<SubmitResult>;
    awaitConfirmation(
      txHash: string,
      confirmations: number,
      timeoutMs: number,
    ): Promise<BlockRef>;
  };
  batches: {
    persistBatch(batch: {
      root: string;
      entries: AnchorEntry[];
    }): Promise<number>;
    markSubmitted(batchId: number, txHash: string): Promise<void>;
    markConfirmed(batchId: number, block: BlockRef): Promise<void>;
    markFailed(batchId: number, errorMessage: string): Promise<void>;
  };
  alerts: {
    recordSignatureMismatch(
      recordId: number,
      details: string,
    ): Promise<boolean>;
  };
}

export interface CollectedBatch {
  batch: { root: string; size: number; entries: AnchorEntry[] } | null;
  scannedCount: number;
  rejectedCount: number;
  stageMs: { scanAndValidate: number; tree: number };
}

export interface CycleOptions {
  cycleNumber: number;
  whitelistedAddresses: string[];
  confirmations: number;
  confirmationTimeoutMs: number;
  maxBatchSize: number | null;
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
 * 1. Pulls up to `limit` un-anchored records from `recordStream` (or every
 *    remaining record, if `limit` is `null`) — `recordStream` is created
 *    once per cycle by the caller and reused across calls, so each call
 *    picks up exactly where the previous one left off.
 * 2. Validates each one (signature + whitelist).
 * 3. Alerts the ones that fail.
 * 4. Builds a Merkle tree from the valid ones.
 *
 * `scannedCount`/`rejectedCount` are always real counts, even when
 * `batch` is `null` — the caller needs `scannedCount` to tell "the stream
 * is exhausted" (0) apart from "every record in this chunk was rejected"
 * (>0), since only the former means there is nothing left to loop for.
 * Never calls `buildAnchorTree` with an empty array.
 */
export async function collectValidBatch(
  deps: Pick<CycleDeps, "alerts">,
  recordStream: AsyncGenerator<AnchorableRecord>,
  whitelistedAddresses: string[],
  logger: Logger,
  limit: number | null,
): Promise<CollectedBatch> {
  const scanStart = performance.now();
  const leaves: LeafEntry[] = [];
  let scannedCount = 0;
  let rejectedCount = 0;

  /**
   * The biggest bottleneck is here, ESCDA signature verification is expensive, and we have to do it for every record.
   * We could consider batching or parallelizing this in the future, but for now, we process them sequentially.
   */
  while (limit === null || scannedCount < limit) {
    const { value: record, done } = await recordStream.next();
    if (done) break;

    scannedCount++;
    const verdict = validateRecord(record, whitelistedAddresses);

    if (!verdict.ok) {
      rejectedCount++;

      logger.warn(
        { recordId: verdict.recordId, reason: verdict.reason },
        "record rejected during re-validation",
      );

      await deps.alerts.recordSignatureMismatch(
        verdict.recordId,
        verdict.reason,
      );
      continue;
    }

    leaves.push({ recordId: verdict.recordId, leaf: verdict.leaf });
  }

  const scanAndValidateMs = performance.now() - scanStart;

  if (leaves.length === 0) {
    return {
      batch: null,
      scannedCount,
      rejectedCount,
      stageMs: { scanAndValidate: scanAndValidateMs, tree: 0 },
    };
  }

  const treeStart = performance.now();
  const tree = buildAnchorTree(leaves);
  const treeMs = performance.now() - treeStart;

  return {
    batch: {
      root: tree.root,
      size: tree.entries.length,
      entries: tree.entries.map((entry) => ({
        recordId: entry.recordId,
        proof: entry.proof,
      })),
    },
    scannedCount,
    rejectedCount,
    stageMs: { scanAndValidate: scanAndValidateMs, tree: treeMs },
  };
}

/**
 * Submits a persisted batch's root and waits for confirmations
 * before this same cycle ends. A `RevertedTransactionError` from
 * `awaitConfirmation` is the one deterministic outcome, everything
 * else (timeout, network failure) leaves the batch `submitted` rather than
 * guessing at its fate; Phase 0 reconciles it next cycle.
 */
export async function submitAndConfirmBatch(
  deps: Pick<CycleDeps, "chain" | "batches">,
  batch: { id: number; merkleRoot: string; size: number },
  options: { confirmations: number; confirmationTimeoutMs: number },
  logger: Logger,
): Promise<SubmitAndConfirmResult> {
  const submitStart = performance.now();
  const alreadyOnChain = await deps.chain.findRootOnChain(batch.merkleRoot);

  /**
   * Check if the root exists to avoid unnecessary send.
   * This rarely happens, it's a safeguard against racing
   * conditions across multiple instances of the anchor-service.
   */
  if (alreadyOnChain) {
    await deps.batches.markConfirmed(batch.id, alreadyOnChain);

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
    result = await deps.chain.submitRoot(
      batch.merkleRoot,
      batch.size,
      batch.id,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(
      { batchId: batch.id, err: message },
      "failed to submit new batch",
    );

    await deps.batches.markFailed(batch.id, message);
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
    const block = await deps.chain.findRootOnChain(batch.merkleRoot);

    /**
     * This should never happen, but if it does,
     * log an error and mark the batch as failed.
     * This is a safeguard against inconsistencies in the RPC provider.
     */
    if (!block) {
      const message = `addMerkleRoot reported RootAlreadyExists for batch ${batch.id} but the root is not findable on-chain`;
      logger.error({ batchId: batch.id }, message);
      await deps.batches.markFailed(batch.id, message);
      return {
        status: "failed",
        errorMessage: message,
        stageMs: { submit: performance.now() - submitStart, confirm: 0 },
      };
    }

    await deps.batches.markConfirmed(batch.id, block);
    return {
      status: "confirmed",
      block,
      txHash: null,
      stageMs: { submit: performance.now() - submitStart, confirm: 0 },
    };
  }

  const submitMs = performance.now() - submitStart;
  const txHash = result.tx.hash;
  await deps.batches.markSubmitted(batch.id, txHash);

  const confirmStart = performance.now();

  /**
   * Get confirmation for the submitted transaction.
   * If the transaction is reverted, mark the batch as failed.
   */
  try {
    const block = await deps.chain.awaitConfirmation(
      txHash,
      options.confirmations,
      options.confirmationTimeoutMs,
    );

    await deps.batches.markConfirmed(batch.id, block);
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
      await deps.batches.markFailed(batch.id, message);
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

/**
 * Rolls every chunk's outcome up into one cycle-level status. "Worst case
 * wins": a shutdown mid-loop always wins (nothing else in the cycle matters
 * once that's happened), then any failed chunk, then any still-unresolved
 * ("submitted") chunk, and only "confirmed" when every chunk is. Zero
 * chunks at all is "nothing-to-anchor", distinct from every chunk failing.
 */
function rollUpStatus(aborted: boolean, batches: BatchOutcome[]): CycleStatus {
  if (aborted) return "aborted";
  if (batches.length === 0) return "nothing-to-anchor";
  if (batches.some((batch) => batch.status === "failed")) return "failed";
  if (batches.some((batch) => batch.status === "submitted")) return "submitted";
  return "confirmed";
}

/**
 * Sequences one full anchoring cycle:
 * 1. Phase 0 (reconcile in-flight batches),
 * 2. Phases 1–6 repeated once per chunk — one open record stream for the
 *    whole cycle, sliced into `options.maxBatchSize`-sized chunks (or one
 *    unbounded chunk, draining the entire backlog, when `maxBatchSize` is
 *    `null`) — until a chunk scans zero records (the stream is exhausted)
 *    or shutdown is requested,
 * 3. Phase 7 (summary, aggregated across every chunk this cycle ran).
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

  const recordStream = deps.records.streamUnanchoredRecords();

  let scanned = 0;
  let rejected = 0;
  let batched = 0;
  let scanAndValidateMs = 0;
  let treeMs = 0;
  let persistMs = 0;
  let submitMs = 0;
  let confirmMs = 0;
  const batches: BatchOutcome[] = [];
  let aborted = false;

  while (true) {
    // Phases 1-3
    const collected = await collectValidBatch(
      deps,
      recordStream,
      options.whitelistedAddresses,
      logger,
      options.maxBatchSize,
    );
    scanned += collected.scannedCount;
    rejected += collected.rejectedCount;
    scanAndValidateMs += collected.stageMs.scanAndValidate;
    treeMs += collected.stageMs.tree;

    if (collected.scannedCount === 0) break;

    if (collected.batch) {
      const batch = collected.batch;

      // Phase 4
      const { result: batchId, ms: chunkPersistMs } = await timed(() =>
        deps.batches.persistBatch({ root: batch.root, entries: batch.entries }),
      );
      persistMs += chunkPersistMs;
      batched += batch.size;

      if (shouldAbort()) {
        aborted = true;
        logger.warn(
          { cycle: options.cycleNumber, batchId },
          "shutdown requested — leaving batch 'pending' for the next startup's Phase 0 to submit",
        );
        batches.push({
          root: batch.root,
          size: batch.size,
          status: "pending",
          txHash: null,
          blockNumber: null,
          gasUsed: null,
          gasPrice: null,
        });
        break;
      }

      // Phases 5-6
      const submitResult = await submitAndConfirmBatch(
        deps,
        { id: batchId, merkleRoot: batch.root, size: batch.size },
        {
          confirmations: options.confirmations,
          confirmationTimeoutMs: options.confirmationTimeoutMs,
        },
        logger,
      );
      submitMs += submitResult.stageMs.submit;
      confirmMs += submitResult.stageMs.confirm;

      batches.push({
        root: batch.root,
        size: batch.size,
        status: submitResult.status,
        txHash: submitResult.status === "failed" ? null : submitResult.txHash,
        blockNumber:
          submitResult.status === "confirmed"
            ? submitResult.block.number
            : null,
        gasUsed:
          submitResult.status === "confirmed"
            ? (submitResult.block.gasUsed ?? null)
            : null,
        gasPrice:
          submitResult.status === "confirmed"
            ? (submitResult.block.gasPrice ?? null)
            : null,
      });
    }

    // An unbounded chunk (no configured max) always drains the entire
    // backlog by construction — there is never a second chunk to try.
    if (options.maxBatchSize === null) break;

    // Between-chunks checkpoint: lets shutdown stop the loop once a chunk
    // has fully completed, without starting a new chunk's work — distinct
    // from the per-chunk checkpoint above, which protects a chunk already
    // in flight.
    if (shouldAbort()) {
      aborted = true;
      break;
    }
  }

  if (batches.length === 0 && !aborted) {
    logger.info({ cycle: options.cycleNumber }, "nothing to anchor this cycle");
  }

  // Phase 7
  const summary = buildCycleSummary({
    cycle: options.cycleNumber,
    reconciled,
    scanned,
    rejected,
    batched,
    batches,
    status: rollUpStatus(aborted, batches),
    durationMs: performance.now() - cycleStart,
    stageMs: {
      reconcile: reconcileMs,
      scanAndValidate: scanAndValidateMs,
      tree: treeMs,
      persist: persistMs,
      submit: submitMs,
      confirm: confirmMs,
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

  const provider = createProviderAdapter(chain);

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
    records: {
      streamUnanchoredRecords: () => dbStreamUnanchoredRecords(pool),
    },
    chain: {
      findRootOnChain: (root) =>
        chainFindRootOnChain(chain.contract, provider, root),
      submitRoot: (root, size, batchId) =>
        chainSubmitRoot(chain.contract, provider, root, size, batchId, {
          retries: config.txRetries,
          maxFeeGwei: config.maxFeeGwei,
        }),
      awaitConfirmation: (txHash, confirmations, timeoutMs) =>
        chainAwaitConfirmation(provider, txHash, confirmations, timeoutMs),
    },
    batches: {
      persistBatch: (batch) => dbPersistBatch(pool, batch),
      markSubmitted: (batchId, txHash) =>
        dbMarkSubmitted(pool, batchId, txHash),
      markConfirmed: (batchId, block) => dbMarkConfirmed(pool, batchId, block),
      markFailed: (batchId, errorMessage) =>
        dbMarkFailed(pool, batchId, errorMessage),
    },
    alerts: {
      recordSignatureMismatch: (recordId, details) =>
        dbRecordSignatureMismatch(pool, recordId, details),
    },
  };
}
