import type { MerkleAnchorRegistryLike } from "contracts-shared";
import type { ChainProvider } from "./chain.ts";

export interface BlockRef {
  number: number;
  timestamp: number;
}

export class RevertedTransactionError extends Error {
  txHash: string;
  constructor(txHash: string) {
    super(`transaction ${txHash} was mined but reverted`);
    this.name = "RevertedTransactionError";
    this.txHash = txHash;
  }
}

export type ReceiptOutcome =
  | { kind: "missing" }
  | { kind: "reverted" }
  | { kind: "pending-confirmations"; confirmationsSoFar: number }
  | { kind: "confirmed"; block: BlockRef };

/**
 * Finds the block number and timestamp of a root on-chain by checking if the root exists and querying the RootAdded event.
 * @param contract - The contract instance with methods to check for the root and query events.
 * @param provider - The provider instance to fetch block details.
 * @param root - The Merkle root to check on-chain.
 * @returns A BlockRef object containing the block number and timestamp if the root is found, or null if not found.
 * @throws An error if the root is reported on-chain but no matching event is found, or if the block for the event cannot be retrieved.
 */
export async function findRootOnChain(
  contract: Pick<
    MerkleAnchorRegistryLike,
    "containsMerkleRoot" | "filters" | "queryFilter"
  >,
  provider: Pick<ChainProvider, "getBlock">,
  root: string,
): Promise<BlockRef | null> {
  const exists = await contract.containsMerkleRoot(root);
  if (!exists) return null;

  const logs = await contract.queryFilter(
    contract.filters.RootAdded(undefined, root),
  );

  if (logs.length === 0) {
    throw new Error(
      `containsMerkleRoot(${root}) is true but no RootAdded event was found — invariant violation`,
    );
  }

  const block = await provider.getBlock(logs[0].blockNumber);
  if (!block) {
    throw new Error(
      `block ${logs[0].blockNumber} for RootAdded(${root}) not found`,
    );
  }

  return { number: logs[0].blockNumber, timestamp: block.timestamp };
}

/**
 * Blocks until `txHash` reaches `confirmations` confirmations (or the
 * timeout elapses), then resolves its block ref. Throws
 * `RevertedTransactionError` if the transaction was mined but reverted.
 */
export async function awaitConfirmation(
  provider: Pick<ChainProvider, "waitForTransaction" | "getBlock">,
  txHash: string,
  confirmations: number,
  timeoutMs: number,
): Promise<BlockRef> {
  const receipt = await provider.waitForTransaction(
    txHash,
    confirmations,
    timeoutMs,
  );

  if (!receipt) {
    throw new Error(
      `transaction ${txHash} has no receipt after waiting for confirmations`,
    );
  }

  if (receipt.status === 0) {
    throw new RevertedTransactionError(txHash);
  }

  const block = await provider.getBlock(receipt.blockNumber);
  if (!block) {
    throw new Error(
      `block ${receipt.blockNumber} for transaction ${txHash} not found`,
    );
  }

  return { number: receipt.blockNumber, timestamp: block.timestamp };
}

/**
 * Non-blocking snapshot of a transaction's on-chain status, unlike
 * `awaitConfirmation`, never waits;
 * used to poll a submitted transaction across reconcile cycles.
 */
export async function inspectTransaction(
  provider: Pick<
    ChainProvider,
    "getTransactionReceipt" | "getBlockNumber" | "getBlock"
  >,
  txHash: string,
  requiredConfirmations: number,
): Promise<ReceiptOutcome> {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return { kind: "missing" };
  if (receipt.status === 0) return { kind: "reverted" };

  const currentBlock = await provider.getBlockNumber();
  const confirmationsSoFar = currentBlock - receipt.blockNumber + 1;

  if (confirmationsSoFar < requiredConfirmations) {
    return { kind: "pending-confirmations", confirmationsSoFar };
  }

  const block = await provider.getBlock(receipt.blockNumber);
  if (!block) {
    throw new Error(
      `block ${receipt.blockNumber} for transaction ${txHash} not found`,
    );
  }

  return {
    kind: "confirmed",
    block: { number: receipt.blockNumber, timestamp: block.timestamp },
  };
}
