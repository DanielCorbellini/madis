/**
 * On-chain deployments of the integrity contracts, keyed by chain id.
 *
 * GENERATED from `apps/integrity-domain/ignition/deployments/` by
 * `hardhat export-deployments` (also run during `hardhat build`).
 * Do not edit by hand.
 */
export const deployments: Record<string, { MerkleAnchorRegistry: string }> = {
  "80002": { MerkleAnchorRegistry: "0xF3C280280Fae0aB49334Fe30781879eb3476cF62" },
};

export function merkleAnchorRegistryAddress(
  chainId: number,
): string | undefined {
  return deployments[String(chainId)]?.MerkleAnchorRegistry;
}
