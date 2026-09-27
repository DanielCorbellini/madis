/**
 * Asserts that the network returned by the provider matches the expected chain ID.
 * Throws an error if the chain IDs do not match.
 */
export async function assertNetworkMatches(
  provider: { getNetwork(): Promise<{ chainId: bigint }> },
  expectedChainId: number,
): Promise<void> {
  const network = await provider.getNetwork();

  if (network.chainId !== BigInt(expectedChainId)) {
    throw new Error(
      `RPC provider is on chain ${network.chainId}, expected ${expectedChainId}`,
    );
  }
}

/**
 * Asserts that a contract is deployed at the given address by checking
 * for non-empty bytecode.
 */
export async function assertContractDeployed(
  provider: { getCode(address: string): Promise<string> },
  address: string,
): Promise<void> {
  const code = await provider.getCode(address);

  if (code === "0x") {
    throw new Error(`No contract bytecode found at ${address}`);
  }
}
