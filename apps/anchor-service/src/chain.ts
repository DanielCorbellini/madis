import {
  adaptMerkleAnchorRegistry,
  getMerkleAnchorRegistry,
  type MerkleAnchorRegistryLike,
} from "contracts-shared";
import {
  getAddress,
  JsonRpcProvider,
  Wallet,
  type TransactionReceipt,
} from "ethers";
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
  getTransactionReceipt(hash: string): Promise<{
    status: number;
    blockNumber: number;
    gasUsed?: bigint;
    gasPrice?: bigint;
  } | null>;
  waitForTransaction(
    hash: string,
    confirms: number,
    timeout: number,
  ): Promise<{
    status: number;
    blockNumber: number;
    gasUsed?: bigint;
    gasPrice?: bigint;
  } | null>;
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

function toBlockRefReceipt(receipt: TransactionReceipt | null): {
  status: number;
  blockNumber: number;
  gasUsed?: bigint;
  gasPrice?: bigint;
} | null {
  if (!receipt) return null;

  return {
    status: receipt.status ?? 0,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    gasPrice: receipt.gasPrice,
  };
}

/**
 * Adapts a ChainClient's real ethers provider to the narrower `ChainProvider`
 * shape consumed by chain-submit/chain-confirm/cycle/reconcile, coercing
 * ethers' nullable receipt `status` to the non-null shape those modules expect.
 */
export function createProviderAdapter(chain: ChainClient): ChainProvider {
  return {
    getFeeData: () => chain.provider.getFeeData(),
    getTransaction: (hash) => chain.provider.getTransaction(hash),
    getBlock: (blockNumber) => chain.provider.getBlock(blockNumber),
    getBlockNumber: () => chain.provider.getBlockNumber(),
    getTransactionReceipt: async (hash) =>
      toBlockRefReceipt(await chain.provider.getTransactionReceipt(hash)),
    waitForTransaction: async (hash, confirms, timeout) =>
      toBlockRefReceipt(
        await chain.provider.waitForTransaction(hash, confirms, timeout),
      ),
    getCode: (address) => chain.provider.getCode(address),
    getNetwork: () => chain.provider.getNetwork(),
  };
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
