/**
 * On-chain deployments of the integrity contracts, keyed by chain id.
 *
 * GENERATED from `apps/integrity-domain/ignition/deployments/` by
 * `hardhat export-deployments` (also run during `hardhat build`).
 * Do not edit by hand.
 */
export const deployments: Record<string, { MerkleAnchorRegistry: string }> = {
  "31337": {
    MerkleAnchorRegistry: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  },
  // Polygon Amoy
  "80002": {
    MerkleAnchorRegistry: "0x0C8B43107C1306B8F9379B4D7D52d9eeA7D749E8",
  },
  // Arbitrum Sepolia
  "421614": {
    MerkleAnchorRegistry: "0x570CB9E293063523514aEE7627E501B3bCeE156B",
  },
  // Ethereum Sepolia
  "11155111": {
    MerkleAnchorRegistry: "0x5225186d56DB89a851706588719b50504d12e1F7",
  },
};

export function merkleAnchorRegistryAddress(
  chainId: number,
): string | undefined {
  return deployments[String(chainId)]?.MerkleAnchorRegistry;
}
