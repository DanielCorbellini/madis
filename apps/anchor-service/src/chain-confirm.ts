export interface BlockRef {
  number: number;
  timestamp: number;
}

/**
 * Finds the block number and timestamp of a root on-chain by checking if the root exists and querying the RootAdded event.
 * @param contract - The contract instance with methods to check for the root and query events.
 * @param provider - The provider instance to fetch block details.
 * @param root - The Merkle root to check on-chain.
 * @returns A BlockRef object containing the block number and timestamp if the root is found, or null if not found.
 * @throws An error if the root is reported on-chain but no matching event is found, or if the block for the event cannot be retrieved.
 */
export async function findRootOnChain(
  contract: {
    containsMerkleRoot(root: string): Promise<boolean>;
    filters: { RootAdded(index?: unknown, root?: string): unknown };
    queryFilter(filter: unknown): Promise<Array<{ blockNumber: number }>>;
  },
  provider: {
    getBlock(blockNumber: number): Promise<{ timestamp: number } | null>;
  },
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
