import { computeLeafHash } from "crypto-utils";
import type { ContractTransactionResponse } from "ethers/contract";
import type { Pool } from "pg";
import type { Logger } from "service-runtime";
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
  type ReceiptOutcome,
} from "./chain-confirm.ts";
import {
  resendTransaction as chainResendTransaction,
  submitRoot as chainSubmitRoot,
  type SubmitResult,
} from "./chain-submit.ts";
import type { ChainClient, ChainProvider } from "./chain.ts";
import type { AnchorableRecord } from "./record.ts";
import { buildAnchorTree, type LeafEntry } from "./tree.ts";

export interface ReconcileDeps {
  findInFlightBatches(): Promise<Batch[]>;
  streamBatchRecords(batchId: number): AsyncGenerator<AnchorableRecord>;
  markSubmitted(batchId: number, txHash: string): Promise<void>;
  markConfirmed(batchId: number, block: BlockRef): Promise<void>;
  markFailed(batchId: number, errorMessage: string): Promise<void>;
  findRootOnChain(root: string): Promise<BlockRef | null>;
  submitRoot(root: string, size: number): Promise<SubmitResult>;
  inspectTransaction(
    txHash: string,
    confirmations: number,
  ): Promise<ReceiptOutcome>;
  resendTransaction(
    root: string,
    size: number,
    oldTxHash: string,
  ): Promise<Pick<ContractTransactionResponse, "hash">>;
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
    const alreadyOnChain = await deps.findRootOnChain(batch.merkleRoot);

    if (alreadyOnChain) {
      await deps.markConfirmed(batch.id, alreadyOnChain);
      summary.confirmed++;
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
    result = await deps.submitRoot(batch.merkleRoot, batch.size);
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
    const block = await deps.findRootOnChain(batch.merkleRoot);

    if (!block) {
      const message = `addMerkleRoot reported RootAlreadyExists for batch ${batch.id} but the root is not findable on-chain`;
      logger.error({ batchId: batch.id }, message);

      await deps.markFailed(batch.id, message);
      summary.failed++;
      return;
    }

    await deps.markConfirmed(batch.id, block);
    summary.confirmed++;
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
      const tx = await deps.resendTransaction(
        batch.merkleRoot,
        batch.size,
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
    entries.push({
      recordId: record.id,
      leaf: computeLeafHash(
        String(record.id),
        record.payload,
        record.signature,
      ),
    });
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
  const rebuiltRoot = await rebuildTreeRoot(deps, batch.id);

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
    const result = await deps.submitRoot(batch.merkleRoot, batch.size);

    if (result.status === "already-on-chain") {
      const block = await deps.findRootOnChain(batch.merkleRoot);

      if (!block) {
        const message = `addMerkleRoot reported RootAlreadyExists for batch ${batch.id} but the root is not findable on-chain`;
        await deps.markFailed(batch.id, message);
        summary.failed++;
        return;
      }

      await deps.markConfirmed(batch.id, block);
      summary.confirmed++;
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
  const contract = {
    addMerkleRoot: (
      root: string,
      size: number,
      overrides?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    ) => chain.contract.addMerkleRoot(root, size, overrides ?? {}),
    containsMerkleRoot: (root: string) =>
      chain.contract.containsMerkleRoot(root),
    filters: chain.contract.filters,
    queryFilter: (filter: unknown) =>
      chain.contract.queryFilter(filter as never),
  };

  const provider: Pick<
    ChainProvider,
    | "getFeeData"
    | "getTransaction"
    | "getBlock"
    | "getBlockNumber"
    | "getTransactionReceipt"
  > = {
    getFeeData: () => chain.provider.getFeeData(),
    getTransaction: (hash: string) => chain.provider.getTransaction(hash),
    getBlock: (blockNumber: number) => chain.provider.getBlock(blockNumber),
    getBlockNumber: () => chain.provider.getBlockNumber(),
    getTransactionReceipt: async (hash: string) => {
      const receipt = await chain.provider.getTransactionReceipt(hash);
      if (!receipt) return null;
      return { status: receipt.status ?? 0, blockNumber: receipt.blockNumber };
    },
  };

  return {
    findInFlightBatches: () => dbFindInFlightBatches(pool),
    streamBatchRecords: (batchId) => dbStreamBatchRecords(pool, batchId),
    markSubmitted: (batchId, txHash) => dbMarkSubmitted(pool, batchId, txHash),
    markConfirmed: (batchId, block) => dbMarkConfirmed(pool, batchId, block),
    markFailed: (batchId, errorMessage) =>
      dbMarkFailed(pool, batchId, errorMessage),
    findRootOnChain: (root) => chainFindRootOnChain(contract, provider, root),
    submitRoot: (root, size) =>
      chainSubmitRoot(contract, provider, root, size, {
        retries: options.retries,
        maxFeeGwei: options.maxFeeGwei,
      }),
    inspectTransaction: (txHash, confirmations) =>
      chainInspectTransaction(provider, txHash, confirmations),
    resendTransaction: (root, size, oldTxHash) =>
      chainResendTransaction(
        contract,
        provider,
        root,
        size,
        oldTxHash,
        options.maxFeeGwei,
      ),
  };
}
