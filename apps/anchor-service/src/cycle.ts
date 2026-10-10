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
  findRootOnChain as chainFindRootOnChain,
  RevertedTransactionError,
} from "./chain-confirm.ts";
import {
  submitRoot as chainSubmitRoot,
  type SubmitResult,
} from "./chain-submit.ts";
import { type ChainClient, createProviderAdapter } from "./chain.ts";
import type { AnchorConfig } from "./config.ts";
import { buildCycleSummary, type CycleSummary } from "./metrics.ts";
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
    findRootOnChain(root: string): Promise<OnChainRootOwner | null>;
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

export interface CollectedBatch {
  root: string;
  size: number;
  entries: AnchorEntry[];
  scannedCount: number;
  rejectedCount: number;
  stageMs: { scanAndValidate: number; tree: number };
}

export interface CycleOptions {
  cycleNumber: number;
  whitelistedAddresses: string[];
  confirmations: number;
  confirmationTimeoutMs: number;
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
 * 1. Get every un-anchored record
 * 2. Validates each one (signature + whitelist)
 * 3. Alerts the ones that fails
 * 4. Build a Merkle Tree from the valid ones
 *
 * Returns `null` ("nothing to anchor") if zero records passed validation;
 * never calls `buildAnchorTree` with an empty array.
 */
export async function collectValidBatch(
  deps: Pick<CycleDeps, "records"> & {
    alerts: Pick<CycleDeps["alerts"], "recordSignatureMismatch">;
  },
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
   *
   * The biggest bottleneck is here, ESCDA signature verification is expensive, and we have to do it for every record.
   * We could consider batching or parallelizing this in the future, but for now, we process them sequentially.
   */
  for await (const record of deps.records.streamUnanchoredRecords()) {
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

/**
 * The batch's root is already on-chain. Only a root owned by THIS batch id
 * means "my batch is confirmed" (the same-batch race this check exists for).
 * A root owned by a different batch id can never give this batch its own
 * `BatchInfo`: don't confirm it — mark it failed with an explicit message and
 * alert once. Its anchor_records pins were persisted before this was known
 * and can't be moved (no UPDATE/DELETE grant).
 */
async function settleOwnedRoot(
  deps: Pick<SubmitDeps, "batches" | "alerts">,
  batch: { id: number; merkleRoot: string },
  owner: OnChainRootOwner,
  logger: Logger,
  submitStart: number,
): Promise<SubmitAndConfirmResult> {
  if (owner.ownerBatchId === batch.id) {
    await deps.batches.markConfirmed(batch.id, owner.block);

    return {
      status: "confirmed",
      block: owner.block,
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
 * Sequences one full anchoring cycle:
 * 1. Phase 0 (reconcile in-flight batches),
 * 2. Phases 1–3 (collect a new valid batch, or "nothing to anchor"),
 * 2b. Phase 3.5 (skip a collection whose root already exists on-chain),
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
      gasUsed: null,
      gasPrice: null,
      status: "nothing-to-anchor",
      durationMs: performance.now() - cycleStart,
      stageMs: { reconcile: reconcileMs, collect: collectMs },
      peakRssBytes: snapshotMemory().rssBytes,
    });
  }

  // Phase 3.5: if this exact root is already on-chain (under some batch),
  // the contract would reject it. Persist nothing and end this collection —
  // a phantom 'confirmed' row here is the bug this guard exists to prevent.
  const { result: existingOwner, ms: duplicateCheckMs } = await timed(() =>
    deps.chain.findRootOnChain(collected.root),
  );

  if (existingOwner) {
    const ownerRowExists = await deps.batches.batchExists(
      existingOwner.ownerBatchId,
    );
    const ownerState = ownerRowExists
      ? `batch ${existingOwner.ownerBatchId} still exists in Postgres, so its anchor_records pins were likely deleted`
      : `batch ${existingOwner.ownerBatchId} no longer exists in Postgres, so its batches row and pins were likely deleted`;
    const message = `rebuilt root ${collected.root} already exists on-chain (contract RootAlreadyExists) under batch ${existingOwner.ownerBatchId}; ${ownerState}. Skipping ${collected.entries.length} unpinned record(s): nothing inserted. This clears when a new record changes the set.`;

    const isNew = await deps.alerts.recordDuplicateRoot(
      null,
      collected.root,
      message,
    );
    // A stalled set is re-detected every cycle: shout once, then stay visible but quiet.
    logger[isNew ? "error" : "warn"](
      { ownerBatchId: existingOwner.ownerBatchId, root: collected.root },
      message,
    );

    return buildCycleSummary({
      cycle: options.cycleNumber,
      reconciled,
      scanned: collected.scannedCount,
      rejected: collected.rejectedCount,
      batched: 0,
      root: collected.root,
      txHash: null,
      blockNumber: null,
      gasUsed: null,
      gasPrice: null,
      status: "duplicate-skipped",
      durationMs: performance.now() - cycleStart,
      stageMs: {
        reconcile: reconcileMs,
        ...collected.stageMs,
        duplicateCheck: duplicateCheckMs,
      },
      peakRssBytes: snapshotMemory().rssBytes,
    });
  }

  // Phase 4
  const { result: batchId, ms: persistMs } = await timed(() =>
    deps.batches.persistBatch({
      root: collected.root,
      entries: collected.entries,
    }),
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
      gasUsed: null,
      gasPrice: null,
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
    gasUsed:
      submitResult.status === "confirmed"
        ? (submitResult.block.gasUsed ?? null)
        : null,
    gasPrice:
      submitResult.status === "confirmed"
        ? (submitResult.block.gasPrice ?? null)
        : null,
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
