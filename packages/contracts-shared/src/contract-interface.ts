import type { ContractTransactionResponse } from "ethers";
import type { MerkleAnchorRegistry } from "./index.ts";

/**
 * A custom interface for the MerkleAnchorRegistry contract based on the generated ethers.js
 * Contract interface, exposing only the methods and properties that are used in this application.
 * This allows for easier testing and mocking of the contract in unit tests.
 */
export interface MerkleAnchorRegistryLike {
  addMerkleRoot(
    root: string,
    size: number,
    batchId: number,
    overrides?: {
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      nonce?: number;
    },
  ): Promise<Pick<ContractTransactionResponse, "hash">>;
  containsMerkleRoot(root: string): Promise<boolean>;
  getBatchInfo(batchId: number): Promise<{ root: string; size: number }>;
  filters: { RootAdded(index?: unknown, root?: string): unknown };
  queryFilter(filter: unknown): Promise<Array<{ blockNumber: number }>>;
  owner(): Promise<string>;
}

export function adaptMerkleAnchorRegistry(
  contract: MerkleAnchorRegistry,
): MerkleAnchorRegistryLike {
  return {
    addMerkleRoot: (root, size, batchId, overrides) =>
      contract.addMerkleRoot(root, size, batchId, overrides ?? {}),
    containsMerkleRoot: (root) => contract.containsMerkleRoot(root),
    getBatchInfo: async (batchId) => {
      const [root, size] = await contract.getBatchInfo(batchId);
      return { root, size: Number(size) };
    },
    filters: contract.filters,
    queryFilter: (filter) => contract.queryFilter(filter as never),
    owner: () => contract.owner(),
  };
}
