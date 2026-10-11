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
  getBatchIdByRoot(root: string): Promise<number>;
  getBatchInfo(batchId: number): Promise<{ root: string; size: number }>;
  getRootCount(): Promise<number>;
  getBatchIdsPaged(offset: number, limit: number): Promise<number[]>;
  getMerkleRootsPaged(offset: number, limit: number): Promise<string[]>;
  filters: { RootAdded(index?: unknown, root?: string): unknown };
  queryFilter(
    filter: unknown,
  ): Promise<
    Array<{ blockNumber: number; args: { batchId: bigint; root: string } }>
  >;
  owner(): Promise<string>;
}

export function adaptMerkleAnchorRegistry(
  contract: MerkleAnchorRegistry,
): MerkleAnchorRegistryLike {
  return {
    addMerkleRoot: (root, size, batchId, overrides) =>
      contract.addMerkleRoot(root, size, batchId, overrides ?? {}),
    containsMerkleRoot: (root) => contract.containsMerkleRoot(root),
    getBatchIdByRoot: async (root) => Number(await contract.getBatchIdByRoot(root)),
    getBatchInfo: async (batchId) => {
      const [root, size] = await contract.getBatchInfo(batchId);
      return { root, size: Number(size) };
    },
    getRootCount: async () => Number(await contract.getRootCount()),
    getBatchIdsPaged: async (offset, limit) =>
      (await contract.getBatchIdsPaged(offset, limit)).map(Number),
    getMerkleRootsPaged: async (offset, limit) => [
      ...(await contract.getMerkleRootsPaged(offset, limit)),
    ],
    filters: contract.filters,
    queryFilter: (filter) => contract.queryFilter(filter as never),
    owner: () => contract.owner(),
  };
}
