import { AbiCoder, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { canonicalize } from "./canonicalizer.ts";

const defaultAbiCoder = AbiCoder.defaultAbiCoder();

/**
 * Computes the keccak256 hash of canonicalized payload data.
 */
export function hashPayloadData(data: Record<string, unknown>): string {
  const canonicalJson = canonicalize(data);
  return keccak256(toUtf8Bytes(canonicalJson));
}

export interface ComputeLeafHashInput {
  id: string | number;
  entityId: string | number;
  recordType: string;
  data: Record<string, unknown>;
  version: string | number;
  isDeleted: boolean;
  replaces: string | number | null;
  clientAddress: string;
  signature: string;
  createdAt: Date;
}

/**
 * Computes the leaf hash Li = Keccak256(id || entityId || recordType || Keccak256(payload) || version || isDeleted || replaces || clientAddress || signature || createdAt)
 * This binds every column of a `records` row. Fields are encoded in the same order as
 * the `records` table columns, except for `payload`, which is hashed first.
 */
export function computeLeafHash(input: ComputeLeafHashInput): string {
  const {
    id,
    entityId,
    recordType,
    data,
    version,
    isDeleted,
    replaces,
    clientAddress,
    signature,
    createdAt,
  } = input;

  if (typeof signature !== "string" || !signature.trim()) {
    throw new Error("Invalid signature: signature cannot be empty");
  }

  const dataHash = hashPayloadData(data);
  const createdAtSeconds = Math.floor(createdAt.getTime() / 1000);

  const encoded = defaultAbiCoder.encode(
    [
      "uint256",
      "uint256",
      "string",
      "bytes32",
      "uint256",
      "bool",
      "uint256",
      "address",
      "string",
      "uint256",
    ],
    [
      id,
      entityId,
      recordType,
      dataHash,
      version,
      isDeleted,
      replaces ?? 0,
      getAddress(clientAddress),
      signature,
      createdAtSeconds,
    ],
  );

  return keccak256(encoded);
}
