import type { ContractRunner } from "ethers";
import { MerkleAnchorRegistry__factory } from "./generated/index.js";

export * from "./generated/index.js";

export function getMerkleAnchorRegistry(
  address: string,
  runner: ContractRunner,
) {
  return MerkleAnchorRegistry__factory.connect(address, runner);
}
