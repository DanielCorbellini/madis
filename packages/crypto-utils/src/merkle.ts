import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { AbiCoder, isHexString, keccak256 } from "ethers";
import type { MerkleTreeBuildResult } from "./types.ts";

const defaultAbiCoder = AbiCoder.defaultAbiCoder();

/**
 * Computes the double-hash for a given leaf value
 */
export function getLeafHash(leaf: string): string {
  if (!isHexString(leaf, 32)) {
    throw new Error(`Invalid 32-byte hex leaf: ${leaf}`);
  }

  const encoded = defaultAbiCoder.encode(["bytes32"], [leaf]);
  return keccak256(keccak256(encoded));
}

/**
 * Builds a Merkle tree from an array of 32-byte leaves
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
 * Verifies off-chain whether a leaf belongs to a Merkle tree with the specified root and proof (sibling hashes).
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
