import { isAddress } from "ethers";
import { merkleAnchorRegistryAddress } from "./deployments.js";

/**
 * Resolves the `MerkleAnchorRegistry` address for the target chain: the
 * `CONTRACT_ADDRESS` env override wins (useful for local forks), otherwise the
 * committed deployment registered in `contracts-shared` for that chain id.
 */
export function resolveContractAddress(
  chainId: number,
  override: string | undefined,
  lookup: (chainId: number) => string | undefined = merkleAnchorRegistryAddress,
): string {
  const address = override?.trim() || lookup(chainId);

  if (!address) {
    throw new Error(
      `No contract address for chain ${chainId}: set an override or register a deployment`,
    );
  }

  if (!isAddress(address)) {
    throw new Error(`Contract address is not a valid address: ${address}`);
  }

  return address;
}
