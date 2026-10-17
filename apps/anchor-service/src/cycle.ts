import type { Pool } from "pg";
import {
  type AnchorableRecord,
  type Logger,
  snapshotMemory,
  timed,
} from "service-runtime";
import {
  duplicateRootMessage,
  recordDuplicateRoot as dbRecordDuplicateRoot,
  recordSignatureMismatch as dbRecordSignatureMismatch,
} from "./alerts.ts";
import {
  type AnchorEntry,
  batchExists as dbBatchExists,
  markConfirmed as dbMarkConfirmed,
  markFailed as dbMarkFailed,
  markSubmitted as dbMarkSubmitted,
  persistBatch as dbPersistBatch,
} from "./batch-repository.ts";
import {
  type BlockRef,
  type OnChainRootOwner,
  awaitConfirmation as chainAwaitConfirmation,
  findRootBlock as chainFindRootBlock,
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
import {
  type RecordWindow,
  streamUnanchoredRecords as dbStreamUnanchoredRecords,
} from "./records-source.ts";
import { buildAnchorTree, type LeafEntry } from "./tree.ts";
import { validateRecord } from "./validation.ts";

export interface CycleDeps {
  reconcileBatches(): Promise<ReconcileSummary>;
  records: {
    streamUnanchoredRecords(
      window: RecordWindow,
    ): AsyncGenerator<AnchorableRecord>;
  };
  chain: {
    findRootOnChain(root: string): Promise<OnChainRootOwner | null>;
    findRootBlock(root: string): Promise<BlockRef>;
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
    batchExists(batchId: number): Promise<boolean>;
  };
  alerts: {
    recordSignatureMismatch(
      recordId: number,
      details: string,
    ): Promise<boolean>;
    recordDuplicateRoot(
      batchId: number | null,
      root: string,
      details: string,
    ): Promise<boolean>;
  };
}

/** What `submitAndConfirmBatch` needs — no `records`, no `batchExists`. */
type SubmitDeps = Pick<CycleDeps, "chain"> & {
  batches: Omit<CycleDeps["batches"], "batchExists">;
  alerts: Pick<CycleDeps["alerts"], "recordDuplicateRoot">;
};

/** A validated slice of the backlog, ready to be anchored as one batch. */
export interface BatchToAnchor {
  root: string;
  size: number;
  entries: AnchorEntry[];
}

/**
 * What one read of the backlog found. `batch` is `null` when no record in the
 * window passed validation, but the counts are always real: the caller needs
 * `scannedCount` to know whether the backlog is exhausted, and
 * `lastRecordId` to start the next window after what was already read.
 */
export interface Collection {
  batch: BatchToAnchor | null;
  scannedCount: number;
  rejectedCount: number;
  lastRecordId: number | null;
  stageMs: { scanAndValidate: number; tree: number };
}

export interface CycleOptions {
  cycleNumber: number;
  whitelistedAddresses: string[];
  confirmations: number;
  confirmationTimeoutMs: number;
  /** Most records scanned for one batch (rejected ones count). */
  maxBatchSize: number;
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
 * 1. Reads one window of the un-anchored backlog
 * 2. Validates each record (signature + whitelist)
 * 3. Alerts the ones that fail
 * 4. Builds a Merkle tree from the valid ones
 *
 * Never calls `buildAnchorTree` with an empty array.
 */
export async function collectValidBatch(
  deps: Pick<CycleDeps, "records"> & {
    alerts: Pick<CycleDeps["alerts"], "recordSignatureMismatch">;
  },
  whitelistedAddresses: string[],
  logger: Logger,
  window: RecordWindow = {},
): Promise<Collection> {
  const scanStart = performance.now();
  const leaves: LeafEntry[] = [];
  let scannedCount = 0;
  let rejectedCount = 0;
  let lastRecordId: number | null = null;

  /**
   * Validate every record of the window. Those that pass are added to the Merkle tree,
   * those that fail are logged and an alert is inserted.
   *
   * The biggest bottleneck is here, ESCDA signature verification is expensive, and we have to do it for every record.
   * We could consider batching or parallelizing this in the future, but for now, we process them sequentially.
   */
  for await (const record of deps.records.streamUnanchoredRecords(window)) {
    scannedCount++;
    lastRecordId = record.id;
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
      lastRecordId,
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
    lastRecordId,
    stageMs: { scanAndValidate: scanAndValidateMs, tree: treeMs },
  };
}

/**
 * The batch's root is already on-chain. Only a root owned by THIS batch id
 * means "my batch is confirmed" (the same-batch race this check exists for).
 * A root owned by a different batch id can never give this batch its own
 * `BatchInfo`: don't confirm it — mark it failed with an explicit message and
 * alert once. Its anchor_records pins were persisted before this was known
 * and can't be moved (no UPDATE/DELETE grant).
 */
async function settleOwnedRoot(
  deps: Pick<SubmitDeps, "batches" | "alerts"> & {
    chain: Pick<CycleDeps["chain"], "findRootBlock">;
  },
  batch: { id: number; merkleRoot: string },
  owner: OnChainRootOwner,
  logger: Logger,
  submitStart: number,
): Promise<SubmitAndConfirmResult> {
  if (owner.ownerBatchId === batch.id) {
    // The block is only needed to record this batch's own confirmation.
    const block = await deps.chain.findRootBlock(batch.merkleRoot);
    await deps.batches.markConfirmed(batch.id, block);

    return {
      status: "confirmed",
      block,
      txHash: null,
      stageMs: { submit: performance.now() - submitStart, confirm: 0 },
    };
  }

  const message = duplicateRootMessage({
    batchId: batch.id,
    root: batch.merkleRoot,
    ownerBatchId: owner.ownerBatchId,
  });

  await deps.batches.markFailed(batch.id, message);
  const isNew = await deps.alerts.recordDuplicateRoot(
    batch.id,
    batch.merkleRoot,
    message,
  );
  logger[isNew ? "error" : "warn"](
    { batchId: batch.id, ownerBatchId: owner.ownerBatchId },
    message,
  );

  return {
    status: "failed",
    errorMessage: message,
    stageMs: { submit: performance.now() - submitStart, confirm: 0 },
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
  deps: SubmitDeps,
  batch: { id: number; merkleRoot: string; size: number },
  options: { confirmations: number; confirmationTimeoutMs: number },
  logger: Logger,
): Promise<SubmitAndConfirmResult> {
  const submitStart = performance.now();
  const existingOwner = await deps.chain.findRootOnChain(batch.merkleRoot);

  /**
   * Check if the root exists to avoid unnecessary send. Only a root owned by
   * THIS batch id counts as "my batch is confirmed" — rare, a safeguard
   * against races between Phase 0 and a live cycle for the same batch.
   */
  if (existingOwner) {
    return settleOwnedRoot(deps, batch, existingOwner, logger, submitStart);
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
    const racedOwner = await deps.chain.findRootOnChain(batch.merkleRoot);

    /**
     * This should never happen, but if it does,
     * log an error and mark the batch as failed.
     * This is a safeguard against inconsistencies in the RPC provider.
     */
    if (!racedOwner) {
      const message = `addMerkleRoot reported RootAlreadyExists for batch ${batch.id} but the root is not findable on-chain`;
      logger.error({ batchId: batch.id }, message);
      await deps.batches.markFailed(batch.id, message);
      return {
        status: "failed",
        errorMessage: message,
        stageMs: { submit: performance.now() - submitStart, confirm: 0 },
      };
    }

    return settleOwnedRoot(deps, batch, racedOwner, logger, submitStart);
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
 * Takes one validated batch through Phases 3.5-6: the duplicate-root guard,
 * persistence, the cooperative shutdown checkpoint, then submission and
 * confirmation. Always returns an outcome, never throws for a chain-side
 * failure; the caller decides whether the next batch may go ahead.
 */
export async function anchorBatch(
  deps: CycleDeps,
  batch: BatchToAnchor,
  options: Pick<CycleOptions, "cycleNumber" | "confirmations" | "confirmationTimeoutMs">,
  logger: Logger,
  shouldAbort: () => boolean,
): Promise<BatchOutcome> {
  const nothingSent = {
    root: batch.root,
    size: batch.size,
    txHash: null,
    blockNumber: null,
    gasUsed: null,
    gasPrice: null,
  };

  // Phase 3.5: if this exact root is already on-chain (under some batch),
  // the contract would reject it. Persist nothing and move on — a phantom
  // 'confirmed' row here is the bug this guard exists to prevent.
  const { result: existingOwner, ms: duplicateCheckMs } = await timed(() =>
    deps.chain.findRootOnChain(batch.root),
  );

  if (existingOwner) {
    const ownerRowExists = await deps.batches.batchExists(
      existingOwner.ownerBatchId,
    );
    const ownerState = ownerRowExists
      ? `batch ${existingOwner.ownerBatchId} still exists in Postgres, so its anchor_records pins were likely deleted`
      : `batch ${existingOwner.ownerBatchId} no longer exists in Postgres, so its batches row and pins were likely deleted`;
    const message = `rebuilt root ${batch.root} already exists on-chain (contract RootAlreadyExists) under batch ${existingOwner.ownerBatchId}; ${ownerState}. Skipping ${batch.entries.length} unpinned record(s): nothing inserted. This clears when a new record changes the set.`;

    const isNew = await deps.alerts.recordDuplicateRoot(
      null,
      batch.root,
      message,
    );
    // A stalled set is re-detected every cycle: shout once, then stay visible but quiet.
    logger[isNew ? "error" : "warn"](
      { ownerBatchId: existingOwner.ownerBatchId, root: batch.root },
      message,
    );

    return {
      ...nothingSent,
      status: "duplicate-skipped",
      stageMs: { duplicateCheck: duplicateCheckMs },
    };
  }

  // Phase 4
  const { result: batchId, ms: persistMs } = await timed(() =>
    deps.batches.persistBatch({ root: batch.root, entries: batch.entries }),
  );

  if (shouldAbort()) {
    logger.warn(
      { cycle: options.cycleNumber, batchId },
      "shutdown requested — leaving batch 'pending' for the next startup's Phase 0 to submit",
    );

    return {
      ...nothingSent,
      status: "pending",
      stageMs: { duplicateCheck: duplicateCheckMs, persist: persistMs },
    };
  }

  // Phase 5-6
  const submitResult = await submitAndConfirmBatch(
    deps,
    { id: batchId, merkleRoot: batch.root, size: batch.size },
    {
      confirmations: options.confirmations,
      confirmationTimeoutMs: options.confirmationTimeoutMs,
    },
    logger,
  );

  const stageMs = {
    duplicateCheck: duplicateCheckMs,
    persist: persistMs,
    ...submitResult.stageMs,
  };

  if (submitResult.status === "failed") {
    return { ...nothingSent, status: "failed", stageMs };
  }

  if (submitResult.status === "submitted") {
    return {
      ...nothingSent,
      status: "submitted",
      txHash: submitResult.txHash,
      stageMs,
    };
  }

  return {
    ...nothingSent,
    status: "confirmed",
    txHash: submitResult.txHash,
    blockNumber: submitResult.block.number,
    gasUsed: submitResult.block.gasUsed ?? null,
    gasPrice: submitResult.block.gasPrice ?? null,
    stageMs,
  };
}

/** A batch the cycle can move past: anchored, or safely skipped as a duplicate. */
const isClean = (outcome: BatchOutcome) =>
  outcome.status === "confirmed" || outcome.status === "duplicate-skipped";

/**
 * Rolls the batches of one cycle up into a single status. The first batch that
 * was not clean decides it (the cycle stops there); otherwise the cycle is
 * `confirmed` if anything was anchored, `duplicate-skipped` if everything was
 * a duplicate, and `nothing-to-anchor` if there was no batch at all.
 */
function rollUpStatus(
  outcomes: BatchOutcome[],
  interrupted: boolean,
): CycleStatus {
  const problem = outcomes.find((outcome) => !isClean(outcome));
  if (problem) return problem.status === "pending" ? "aborted" : problem.status;
  if (interrupted) return "aborted";
  if (outcomes.some((outcome) => outcome.status === "confirmed")) {
    return "confirmed";
  }
  return outcomes.length > 0 ? "duplicate-skipped" : "nothing-to-anchor";
}

/**
 * Sequences one full anchoring cycle:
 * 1. Phase 0 (reconcile in-flight batches),
 * 2. a loop over the backlog in windows of `options.maxBatchSize` records —
 *    each window is validated (Phases 1-3) and, if anything passed, anchored
 *    as its own batch (Phases 3.5-6) — until the backlog is exhausted, a batch
 *    does not come out clean, or shutdown is requested,
 * 3. Phase 7 (summary of every batch this cycle ran).
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

  const outcomes: BatchOutcome[] = [];
  const stageMs: Record<string, number> = { reconcile: reconcileMs };
  const addStage = (stage: string, ms: number) => {
    stageMs[stage] = (stageMs[stage] ?? 0) + ms;
  };
  let scanned = 0;
  let rejected = 0;
  let afterId = 0;
  let interrupted = false;

  for (let index = 0; ; index++) {
    // Between batches: shutdown stops the cycle without starting new work.
    if (index > 0 && shouldAbort()) {
      interrupted = true;
      break;
    }

    // Phases 1-3
    const collection = await collectValidBatch(
      deps,
      options.whitelistedAddresses,
      logger,
      { afterId, limit: options.maxBatchSize },
    );
    scanned += collection.scannedCount;
    rejected += collection.rejectedCount;
    addStage("scanAndValidate", collection.stageMs.scanAndValidate);
    addStage("tree", collection.stageMs.tree);

    if (collection.batch) {
      // Phases 3.5-6
      const outcome = await anchorBatch(
        deps,
        collection.batch,
        options,
        logger,
        shouldAbort,
      );
      outcomes.push(outcome);
      for (const [stage, ms] of Object.entries(outcome.stageMs)) {
        addStage(stage, ms);
      }
      logger.info(
        {
          cycle: options.cycleNumber,
          batch: outcomes.length,
          size: outcome.size,
          status: outcome.status,
          root: outcome.root,
        },
        "batch processed",
      );

      if (!isClean(outcome)) break;
    }

    // A short window means the backlog is exhausted.
    if (collection.scannedCount < options.maxBatchSize) break;
    afterId = collection.lastRecordId ?? afterId;
  }

  if (outcomes.length === 0 && !interrupted) {
    logger.info({ cycle: options.cycleNumber }, "nothing to anchor this cycle");
  }

  // Phase 7
  const last = outcomes[outcomes.length - 1];
  const summary = buildCycleSummary({
    cycle: options.cycleNumber,
    reconciled,
    scanned,
    rejected,
    batched: outcomes
      .filter((outcome) => outcome.status !== "duplicate-skipped")
      .reduce((total, outcome) => total + outcome.size, 0),
    root: last?.root ?? null,
    txHash: last?.txHash ?? null,
    blockNumber: last?.blockNumber ?? null,
    gasUsed: last?.gasUsed ?? null,
    gasPrice: last?.gasPrice ?? null,
    batches: outcomes,
    status: rollUpStatus(outcomes, interrupted),
    durationMs: performance.now() - cycleStart,
    stageMs,
    peakRssBytes: snapshotMemory().rssBytes,
  });

  if (outcomes.length > 0 || interrupted) {
    logger.info(summary, "cycle complete");
  }
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
      streamUnanchoredRecords: (window) =>
        dbStreamUnanchoredRecords(pool, window),
    },
    chain: {
      findRootOnChain: (root) => chainFindRootOnChain(chain.contract, root),
      findRootBlock: (root) =>
        chainFindRootBlock(chain.contract, provider, root),
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
      batchExists: (batchId) => dbBatchExists(pool, batchId),
    },
    alerts: {
      recordSignatureMismatch: (recordId, details) =>
        dbRecordSignatureMismatch(pool, recordId, details),
      recordDuplicateRoot: (batchId, root, details) =>
        dbRecordDuplicateRoot(pool, batchId, root, details),
    },
  };
}
