import {
  adaptMerkleAnchorRegistry,
  getMerkleAnchorRegistry,
  type MerkleAnchorRegistryLike,
} from "contracts-shared";
import { getAddress, JsonRpcProvider, Wallet } from "ethers";
import type { AnchorConfig } from "./config.ts";

type ChainClientConfig = Pick<
  AnchorConfig,
  "rpcUrl" | "contractAddress" | "anchorPrivateKey"
>;

export interface ChainClient {
  provider: JsonRpcProvider;
  wallet: Wallet;
  contract: MerkleAnchorRegistryLike;
}

/**
 * Custom interface based on the Provider interface from ethers.js, made for the needs of this application.
 */
export interface ChainProvider {
  getFeeData(): Promise<{
    maxFeePerGas: bigint | null;
    maxPriorityFeePerGas: bigint | null;
  }>;
  getTransaction(hash: string): Promise<{ nonce: number } | null>;
  getBlock(blockNumber: number): Promise<{ timestamp: number } | null>;
  getBlockNumber(): Promise<number>;
  getTransactionReceipt(
    hash: string,
  ): Promise<{ status: number; blockNumber: number } | null>;
  waitForTransaction(
    hash: string,
    confirms: number,
    timeout: number,
  ): Promise<{ status: number; blockNumber: number } | null>;
  getCode(address: string): Promise<string>;
  getNetwork(): Promise<{ chainId: bigint }>;
}

/**
 * Creates a ChainClient instance with a provider, wallet, and contract based on the provided configuration.
 */
export function createChainClient(config: ChainClientConfig): ChainClient {
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, {
    staticNetwork: true,
  });
  const wallet = new Wallet(config.anchorPrivateKey, provider);
  const contract = adaptMerkleAnchorRegistry(
    getMerkleAnchorRegistry(config.contractAddress, wallet),
  );

  return { provider, wallet, contract };
}

/**
 * Asserts that the given wallet address is the owner of the contract.
 * Throws an error if the wallet is not the owner.
 */
export async function assertWalletIsOwner(
  contract: Pick<MerkleAnchorRegistryLike, "owner">,
  walletAddress: string,
): Promise<void> {
  const owner = await contract.owner();
  if (getAddress(owner) !== getAddress(walletAddress)) {
    throw new Error(
      `Anchor wallet ${walletAddress} is not the contract owner (${owner})`,
    );
  }
}
