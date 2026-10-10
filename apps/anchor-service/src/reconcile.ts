import { computeLeafHash } from "crypto-utils";
import type { ContractTransactionResponse } from "ethers/contract";
import type { Pool } from "pg";
import type { AnchorableRecord, Logger } from "service-runtime";
import {
  recordDuplicateRoot as dbRecordDuplicateRoot,
  recordHashFailure as dbRecordHashFailure,
} from "./alerts.ts";
import {
  type Batch,
  type BatchStatus,
  findInFlightBatches as dbFindInFlightBatches,
  markConfirmed as dbMarkConfirmed,
  markFailed as dbMarkFailed,
  markSubmitted as dbMarkSubmitted,
  streamBatchRecords as dbStreamBatchRecords,
} from "./batch-repository.ts";
import {
  type BlockRef,
  findRootOnChain as chainFindRootOnChain,
  inspectTransaction as chainInspectTransaction,
  type OnChainRootOwner,
  type ReceiptOutcome,
} from "./chain-confirm.ts";
import {
  resendTransaction as chainResendTransaction,
  submitRoot as chainSubmitRoot,
  type SubmitResult,
} from "./chain-submit.ts";
import { type ChainClient, createProviderAdapter } from "./chain.ts";
import { buildAnchorTree, type LeafEntry } from "./tree.ts";

export interface ReconcileDeps {
  findInFlightBatches(): Promise<Batch[]>;
  streamBatchRecords(batchId: number): AsyncGenerator<AnchorableRecord>;
  markSubmitted(batchId: number, txHash: string): Promise<void>;
  markConfirmed(batchId: number, block: BlockRef): Promise<void>;
  markFailed(batchId: number, errorMessage: string): Promise<void>;
  findRootOnChain(root: string): Promise<OnChainRootOwner | null>;
  submitRoot(
    root: string,
    size: number,
    batchId: number,
  ): Promise<SubmitResult>;
  inspectTransaction(
    txHash: string,
    confirmations: number,
  ): Promise<ReceiptOutcome>;
  resendTransaction(
    root: string,
    size: number,
    batchId: number,
    oldTxHash: string,
  ): Promise<Pick<ContractTransactionResponse, "hash">>;
  recordHashFailure(
    recordId: number,
    batchId: number,
    details: string,
  ): Promise<boolean>;
  recordDuplicateRoot(
    batchId: number | null,
    root: string,
    details: string,
  ): Promise<boolean>;
}

export interface ReconcileSummary {
  confirmed: number;
  resent: number;
  failed: number;
}

export interface ReconcileOptions {
  confirmations: number;
  retryAlertThreshold: number;
}

/**
 * The batch's root is already on-chain, but registered under a different
 * batch id, so this batch can never get its own `BatchInfo`. Don't confirm
 * it: mark it failed with an explicit message and alert once. Its
 * anchor_records pins already exist and can't be moved (no UPDATE/DELETE
 * grant).
 */
async function failAsDuplicate(
  deps: Pick<ReconcileDeps, "markFailed" | "recordDuplicateRoot">,
  batch: Batch,
  ownerBatchId: number,
  logger: Logger,
  summary: ReconcileSummary,
): Promise<void> {
  const message = `batch ${batch.id}: root ${batch.merkleRoot} already exists on-chain (contract RootAlreadyExists) under batch ${ownerBatchId}, not this batch's id — not confirming; its anchor_records pins cannot be moved (no UPDATE/DELETE grant)`;

  logger.error({ batchId: batch.id, ownerBatchId }, message);

  // An already-failed batch is re-detected every Phase 0; don't bump retry_count each time.
  if (batch.status !== "failed") {
    await deps.markFailed(batch.id, message);
  }
  await deps.recordDuplicateRoot(batch.id, batch.merkleRoot, message);
  summary.failed++;
}

/**
 * Thrown by `rebuildTreeRoot` when a record's own data can't even be hashed
 * (e.g. a malformed `client_address`) — distinguished from the plain `Error`
 * thrown for an empty batch (an invariant violation, meant to propagate and
 * abort the whole reconcile pass) so callers can instead treat this one
 * batch as failed and keep reconciling the rest.
 */
export class RebuildHashError extends Error {
  constructor(batchId: number, recordId: number, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `batch ${batchId}: record ${recordId} could not be hashed while rebuilding the tree — ${reason}`,
    );

    this.name = "RebuildHashError";
  }
}

/**
 * Resolves batches left from a previous cycle
 * (because the process crashed, or the chain was slow between cycles),
 * rather than being the pipeline that creates new batches from raw records.
 *
 * It compares recorded state (batch.status, batch.merkleRoot) against actual
 * on-chain state (findRootOnChain, inspectTransaction) and resolving divergences
 * between the two.
 */
export async function reconcileBatches(
  deps: ReconcileDeps,
  options: ReconcileOptions,
  logger: Logger,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { confirmed: 0, resent: 0, failed: 0 };
  const batches = await deps.findInFlightBatches();

  for (const batch of batches) {
    const existingOwner = await deps.findRootOnChain(batch.merkleRoot);

    if (existingOwner) {
      if (existingOwner.ownerBatchId === batch.id) {
        await deps.markConfirmed(batch.id, existingOwner.block);
        summary.confirmed++;
      } else {
        await failAsDuplicate(
          deps,
          batch,
          existingOwner.ownerBatchId,
          logger,
          summary,
        );
      }
      continue;
    }

    const statusHandlers: Partial<Record<BatchStatus, () => Promise<void>>> = {
      pending: () => reconcilePending(deps, logger, batch, summary),
      submitted: () =>
        reconcileSubmitted(deps, logger, batch, options, summary),
      failed: () => reconcileFailed(deps, logger, batch, options, summary),
    };

    await statusHandlers[batch.status]?.();
  }

  return summary;
}

async function reconcilePending(
  deps: ReconcileDeps,
  logger: Logger,
  batch: Batch,
  summary: ReconcileSummary,
): Promise<void> {
  let result: SubmitResult;
  try {
    result = await deps.submitRoot(batch.merkleRoot, batch.size, batch.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(
      { batchId: batch.id, err: message },
      "failed to submit pending batch",
    );

    await deps.markFailed(batch.id, message);
    summary.failed++;

    return;
  }

  if (result.status === "already-on-chain") {
    const existingOwner = await deps.findRootOnChain(batch.merkleRoot);

    if (!existingOwner) {
      const message = `addMerkleRoot reported RootAlreadyExists for batch ${batch.id} but the root is not findable on-chain`;
      logger.error({ batchId: batch.id }, message);

      await deps.markFailed(batch.id, message);
      summary.failed++;
      return;
    }

    if (existingOwner.ownerBatchId === batch.id) {
      await deps.markConfirmed(batch.id, existingOwner.block);
      summary.confirmed++;
      return;
    }

    await failAsDuplicate(
      deps,
      batch,
      existingOwner.ownerBatchId,
      logger,
      summary,
    );
    return;
  }

  await deps.markSubmitted(batch.id, result.tx.hash);
  summary.resent++;
}

async function reconcileSubmitted(
  deps: ReconcileDeps,
  logger: Logger,
  batch: Batch,
  options: ReconcileOptions,
  summary: ReconcileSummary,
): Promise<void> {
  if (!batch.transactionHash) {
    throw new Error(
      `batch ${batch.id} is 'submitted' but has no transaction hash — invariant violation`,
    );
  }

  const outcome = await deps.inspectTransaction(
    batch.transactionHash,
    options.confirmations,
  );

  switch (outcome.kind) {
    case "confirmed":
      await deps.markConfirmed(batch.id, outcome.block);
      summary.confirmed++;
      return;

    case "reverted":
      logger.warn(
        { batchId: batch.id, txHash: batch.transactionHash },
        "submitted transaction reverted",
      );

      await deps.markFailed(
        batch.id,
        `transaction ${batch.transactionHash} reverted`,
      );

      summary.failed++;
      return;

    case "pending-confirmations":
      return; // re-checked next cycle

    case "missing": {
      let rebuiltRoot: string;
      try {
        rebuiltRoot = await rebuildTreeRoot(deps, batch.id);
      } catch (error) {
        if (error instanceof RebuildHashError) {
          logger.error(
            { batchId: batch.id, err: error.message },
            error.message,
          );

          await deps.markFailed(batch.id, error.message);
          summary.failed++;

          return;
        }

        throw error;
      }

      if (rebuiltRoot !== batch.merkleRoot) {
        const message = `batch ${batch.id}: recomputed root ${rebuiltRoot} diverges from stored root ${batch.merkleRoot} — possible tampering while the transaction was stuck, not auto-resent`;

        logger.error(
          { batchId: batch.id, rebuiltRoot, storedRoot: batch.merkleRoot },
          message,
        );

        await deps.markFailed(batch.id, message);
        summary.failed++;
        return;
      }

      const tx = await deps.resendTransaction(
        batch.merkleRoot,
        batch.size,
        batch.id,
        batch.transactionHash,
      );

      await deps.markSubmitted(batch.id, tx.hash);
      summary.resent++;
      return;
    }
  }
}

async function rebuildTreeRoot(
  deps: ReconcileDeps,
  batchId: number,
): Promise<string> {
  const entries: LeafEntry[] = [];

  for await (const record of deps.streamBatchRecords(batchId)) {
    let leaf: string;
    try {
      leaf = computeLeafHash({
        id: record.id,
        entityId: record.entityId,
        recordType: record.recordType,
        data: record.payload,
        version: record.version,
        isDeleted: record.isDeleted,
        replaces: record.replaces,
        clientAddress: record.clientAddress,
        signature: record.signature,
        createdAt: record.createdAt,
      });
    } catch (error) {
      const rebuildError = new RebuildHashError(batchId, record.id, error);
      await deps.recordHashFailure(record.id, batchId, rebuildError.message);
      throw rebuildError;
    }

    entries.push({ recordId: record.id, leaf });
  }

  if (entries.length === 0) {
    throw new Error(
      `batch ${batchId} has no anchor_records to rebuild its tree from`,
    );
  }

  return buildAnchorTree(entries).root;
}

async function reconcileFailed(
  deps: ReconcileDeps,
  logger: Logger,
  batch: Batch,
  options: ReconcileOptions,
  summary: ReconcileSummary,
): Promise<void> {
  let rebuiltRoot: string;
  try {
    rebuiltRoot = await rebuildTreeRoot(deps, batch.id);
  } catch (error) {
    if (error instanceof RebuildHashError) {
      logger.error({ batchId: batch.id, err: error.message }, error.message);
      await deps.markFailed(batch.id, error.message);

      summary.failed++;
      return;
    }

    throw error;
  }

  if (rebuiltRoot !== batch.merkleRoot) {
    const message = `batch ${batch.id}: recomputed root ${rebuiltRoot} diverges from stored root ${batch.merkleRoot} — possible tampering, not auto-resolved`;

    logger.error(
      { batchId: batch.id, rebuiltRoot, storedRoot: batch.merkleRoot },
      message,
    );

    await deps.markFailed(batch.id, message);
    summary.failed++;
    return;
  }

  const nextRetryCount = batch.retryCount + 1;
  try {
    const result = await deps.submitRoot(
      batch.merkleRoot,
      batch.size,
      batch.id,
    );

    if (result.status === "already-on-chain") {
      const existingOwner = await deps.findRootOnChain(batch.merkleRoot);

      if (!existingOwner) {
        const message = `addMerkleRoot reported RootAlreadyExists for batch ${batch.id} but the root is not findable on-chain`;
        await deps.markFailed(batch.id, message);
        summary.failed++;
        return;
      }

      if (existingOwner.ownerBatchId === batch.id) {
        await deps.markConfirmed(batch.id, existingOwner.block);
        summary.confirmed++;
        return;
      }

      await failAsDuplicate(
        deps,
        batch,
        existingOwner.ownerBatchId,
        logger,
        summary,
      );
      return;
    }

    await deps.markSubmitted(batch.id, result.tx.hash);
    summary.resent++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.markFailed(batch.id, message);
    summary.failed++;
  } finally {
    if (nextRetryCount >= options.retryAlertThreshold) {
      logger.error(
        {
          batchId: batch.id,
          retryCount: nextRetryCount,
          threshold: options.retryAlertThreshold,
        },
        `batch ${batch.id} has failed ${nextRetryCount} times — check for a poison batch (wallet not contract owner, exhausted funds, or a stuck config issue)`,
      );
    }
  }
}

/**
 * Creates a set of dependency functions for reconciling batch statuses.
 */
export function createReconcileDeps(
  chain: ChainClient,
  pool: Pool,
  options: { retries: number; maxFeeGwei: number },
): ReconcileDeps {
  const provider = createProviderAdapter(chain);

  return {
    findInFlightBatches: () => dbFindInFlightBatches(pool),
    streamBatchRecords: (batchId) => dbStreamBatchRecords(pool, batchId),
    markSubmitted: (batchId, txHash) => dbMarkSubmitted(pool, batchId, txHash),
    markConfirmed: (batchId, block) => dbMarkConfirmed(pool, batchId, block),
    markFailed: (batchId, errorMessage) =>
      dbMarkFailed(pool, batchId, errorMessage),
    findRootOnChain: (root) =>
      chainFindRootOnChain(chain.contract, provider, root),
    submitRoot: (root, size, batchId) =>
      chainSubmitRoot(chain.contract, provider, root, size, batchId, {
        retries: options.retries,
        maxFeeGwei: options.maxFeeGwei,
      }),
    inspectTransaction: (txHash, confirmations) =>
      chainInspectTransaction(provider, txHash, confirmations),
    resendTransaction: (root, size, batchId, oldTxHash) =>
      chainResendTransaction(
        chain.contract,
        provider,
        root,
        size,
        batchId,
        oldTxHash,
        options.maxFeeGwei,
      ),
    recordHashFailure: (recordId, batchId, details) =>
      dbRecordHashFailure(pool, recordId, batchId, details),
    recordDuplicateRoot: (batchId, root, details) =>
      dbRecordDuplicateRoot(pool, batchId, root, details),
  };
}
