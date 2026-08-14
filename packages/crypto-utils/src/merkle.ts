import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, AbiCoder, isHexString } from "ethers";
import type { MerkleTreeBuildResult } from "./types.js";

const defaultAbiCoder = AbiCoder.defaultAbiCoder();

/**
 * Computes the canonical double-hash for a given leaf value according to OpenZeppelin StandardMerkleTree rules.
 * Protects against second preimage attacks.
 *
 * @param leaf - A 32-byte hexadecimal string ('0x...')
 * @returns The computed 32-byte leaf hash ('0x...')
 */
export function getLeafHash(leaf: string): string {
  if (!isHexString(leaf, 32)) {
    throw new Error(`Invalid 32-byte hex leaf: ${leaf}`);
  }
  // OpenZeppelin double-hashing rule: keccak256(keccak256(abi.encode(["bytes32"], [leaf])))
  const encoded = defaultAbiCoder.encode(["bytes32"], [leaf]);
  return keccak256(keccak256(encoded));
}

/**
 * Builds a deterministic Merkle tree from an array of 32-byte leaves using OpenZeppelin StandardMerkleTree.
 *
 * @param leaves - Array of 32-byte hexadecimal strings ('0x...')
 * @returns MerkleTreeBuildResult containing the root, input leaves, and proofs for each leaf.
 */
export function buildMerkleTree(leaves: string[]): MerkleTreeBuildResult {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    throw new Error("Cannot build Merkle tree from empty leaves array");
  }

  for (let i = 0; i < leaves.length; i++) {
    if (!isHexString(leaves[i], 32)) {
      throw new Error(`Invalid 32-byte hex leaf at index ${i}: ${leaves[i]}`);
    }
  }

  const values = leaves.map((leaf) => [leaf]);
  const tree = StandardMerkleTree.of(values, ["bytes32"]);

  const proofs: string[][] = [];
  for (let i = 0; i < leaves.length; i++) {
    proofs.push(tree.getProof(i));
  }

  return {
    root: tree.root,
    leaves: [...leaves],
    proofs,
  };
}

/**
 * Verifies off-chain whether a leaf belongs to a Merkle tree with the specified root and proof.
 * Uses OpenZeppelin StandardMerkleTree verification with double-hashing.
 *
 * @param root - The 32-byte Merkle root ('0x...')
 * @param proof - Array of 32-byte proof sibling hashes ('0x...')
 * @param leaf - The raw 32-byte leaf value Li before double-hashing ('0x...')
 * @returns true if the proof is mathematically valid, false otherwise.
 */
export function verifyMerkleProof(
  root: string,
  proof: string[],
  leaf: string,
): boolean {
  try {
    if (
      !isHexString(root, 32) ||
      !isHexString(leaf, 32) ||
      !Array.isArray(proof) ||
      !proof.every((hash) => isHexString(hash, 32))
    ) {
      return false;
    }
    return StandardMerkleTree.verify(root, ["bytes32"], [leaf], proof);
  } catch {
    return false;
  }
}
