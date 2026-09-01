import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploys `MerkleAnchorRegistry`
 */
export default buildModule("MerkleAnchorRegistry", (m) => {
  const registry = m.contract("MerkleAnchorRegistry");

  return { registry };
});
