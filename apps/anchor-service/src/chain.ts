import { getMerkleAnchorRegistry } from "contracts-shared";
import { getAddress, JsonRpcProvider, Wallet } from "ethers";
import type { AnchorConfig } from "./config.ts";

type ChainClientConfig = Pick<
  AnchorConfig,
  "rpcUrl" | "contractAddress" | "anchorPrivateKey"
>;

export interface ChainClient {
  provider: JsonRpcProvider;
  wallet: Wallet;
  contract: ReturnType<typeof getMerkleAnchorRegistry>;
}

export function createChainClient(config: ChainClientConfig): ChainClient {
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, {
    staticNetwork: true,
  });
  const wallet = new Wallet(config.anchorPrivateKey, provider);
  const contract = getMerkleAnchorRegistry(config.contractAddress, wallet);

  return { provider, wallet, contract };
}

export async function assertNetworkMatches(
  provider: { getNetwork(): Promise<{ chainId: bigint }> },
  expectedChainId: number,
): Promise<void> {
  const network = await provider.getNetwork();

  if (network.chainId !== BigInt(expectedChainId)) {
    throw new Error(
      `RPC_URL points at chain ${network.chainId}, expected ${expectedChainId} (ANCHOR_CHAIN_ID)`,
    );
  }
}

export async function assertContractDeployed(
  provider: { getCode(address: string): Promise<string> },
  address: string,
): Promise<void> {
  const code = await provider.getCode(address);

  if (code === "0x") {
    throw new Error(`No contract bytecode found at ${address}`);
  }
}

export async function assertWalletIsOwner(
  contract: { owner(): Promise<string> },
  walletAddress: string,
): Promise<void> {
  const owner = await contract.owner();
  if (getAddress(owner) !== getAddress(walletAddress)) {
    throw new Error(
      `Anchor wallet ${walletAddress} is not the contract owner (${owner})`,
    );
  }
}
