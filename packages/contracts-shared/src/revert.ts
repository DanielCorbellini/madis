import { Interface, isError } from "ethers";
import { MerkleAnchorRegistry__factory } from "./generated/index.js";

const contractInterface = new Interface(MerkleAnchorRegistry__factory.abi);

/**
 * Decodes the name of a revert error if it's a CALL_EXCEPTION
 */
export function decodeRevertName(error: unknown): string | null {
  if (!isError(error, "CALL_EXCEPTION")) {
    return null;
  }

  if (error.revert?.name) {
    return error.revert.name;
  }

  if (error.data) {
    try {
      return contractInterface.parseError(error.data)?.name ?? null;
    } catch {
      return null;
    }
  }

  return null;
}
