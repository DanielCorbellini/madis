import type { ContractRunner } from "ethers";
import { MerkleAnchorRegistry__factory } from "./generated/index.js";

export * from "./deployments.js";
export * from "./generated/index.js";
export * from "./contract-interface.js";
export * from "./resolve-address.js";
export * from "./revert.js";

export function getMerkleAnchorRegistry(
  address: string,
  runner: ContractRunner,
) {
  return MerkleAnchorRegistry__factory.connect(address, runner);
}
