import { buildMerkleTree } from "crypto-utils";

export interface LeafEntry {
  recordId: number;
  leaf: string;
}

export interface AnchorTree {
  root: string;
  entries: Array<{ recordId: number; leaf: string; proof: string[] }>;
}

/**
 * Builds the batch's Merkle tree from validated leaves and pairs each record
 * with its inclusion proof.
 *
 * Note:
 *  Input order is irrelevant — `@openzeppelin/merkle-tree`
 *  sorts leaves by hash, which is why the schema has no `leaf_index` column.
 */
export function buildAnchorTree(leaves: LeafEntry[]): AnchorTree {
  const { root, proofs } = buildMerkleTree(leaves.map((entry) => entry.leaf));

  return {
    root,
    entries: leaves.map((entry, i) => ({
      recordId: entry.recordId,
      leaf: entry.leaf,
      proof: proofs[i],
    })),
  };
}
