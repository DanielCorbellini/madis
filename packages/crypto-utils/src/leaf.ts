import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";
import { canonicalize } from "./canonicalizer.js";

const defaultAbiCoder = AbiCoder.defaultAbiCoder();

/**
 * Computes the keccak256 hash of canonicalized payload data.
 */
export function hashPayloadData(data: Record<string, unknown>): string {
  const canonicalJson = canonicalize(data);
  return keccak256(toUtf8Bytes(canonicalJson));
}

/**
 * Computes the leaf hash Li = Keccak256(abi.encode(id, dataHash, signature)).
 * Follows EVM ABI encoding standard for collision resistance and Solidity interoperability.
 */
export function computeLeafHash(
  id: string | number,
  data: Record<string, unknown>,
  signature: string,
): string {
  if (typeof signature !== "string" || !signature.trim()) {
    throw new Error("Invalid signature: signature cannot be empty");
  }

  const dataHash = hashPayloadData(data);
  const encoded = defaultAbiCoder.encode(
    ["string", "bytes32", "string"],
    [String(id), dataHash, signature],
  );

  return keccak256(encoded);
}
