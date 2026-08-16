import { expect } from "chai";
import { AbiCoder, isHexString, keccak256, toUtf8Bytes } from "ethers";
import { beforeEach, describe, it } from "node:test";
import {
  buildMerkleTree,
  getLeafHash,
  verifyMerkleProof,
} from "../src/merkle.ts";
import type { MerkleTreeBuildResult } from "../src/types.ts";

const defaultAbiCoder = AbiCoder.defaultAbiCoder();

// Helper to generate N mock 32-byte hex leaves
function createMockLeaves(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    keccak256(toUtf8Bytes(`mock-record-payload-${i + 1}`)),
  );
}

describe("merkle tree operations", () => {
  let leaves: string[];
  let tree: MerkleTreeBuildResult;

  beforeEach(() => {
    leaves = createMockLeaves(4);
    tree = buildMerkleTree(leaves);
  });

  it("should build a Merkle Tree and verify proofs for all leaves (Happy Path)", () => {
    expect(isHexString(tree.root, 32)).to.be.true;
    expect(tree.leaves).to.deep.equal(leaves);
    expect(tree.proofs).to.have.lengthOf(4);

    for (let i = 0; i < leaves.length; i++) {
      const isValid = verifyMerkleProof(tree.root, tree.proofs[i], leaves[i]);
      expect(isValid).to.be.true;
    }
  });

  it("should support batches of diverse sizes including odd, even and minimum leaf counts", () => {
    const batchSizes = [2, 3, 5, 7, 8];

    for (const size of batchSizes) {
      const customLeaves = createMockLeaves(size);
      const customTree = buildMerkleTree(customLeaves);

      expect(isHexString(customTree.root, 32)).to.be.true;
      expect(customTree.proofs).to.have.lengthOf(size);

      for (let i = 0; i < size; i++) {
        expect(
          verifyMerkleProof(
            customTree.root,
            customTree.proofs[i],
            customLeaves[i],
          ),
        ).to.be.true;
      }
    }
  });

  it("should compute getLeafHash matching the OpenZeppelin double-hashing formula", () => {
    const leaf = keccak256(toUtf8Bytes("record-test-double-hash"));
    const expectedDoubleHash = keccak256(
      keccak256(defaultAbiCoder.encode(["bytes32"], [leaf])),
    );

    const computed = getLeafHash(leaf);
    expect(computed).to.equal(expectedDoubleHash);
    expect(isHexString(computed, 32)).to.be.true;

    // Should throw if input is not a 32-byte hex
    expect(() => getLeafHash("invalid-hex")).to.throw(
      "Invalid 32-byte hex leaf",
    );
  });

  it("should reject tampered or unauthorized leaves", () => {
    const tamperedLeaf = keccak256(toUtf8Bytes("tampered-data"));
    const isValid = verifyMerkleProof(tree.root, tree.proofs[0], tamperedLeaf);

    expect(isValid).to.be.false;
  });

  it("should reject corrupted proof paths", () => {
    // Corrupt the first hash in the proof path
    const corruptedProof = [...tree.proofs[0]];
    corruptedProof[0] = "0x" + "f".repeat(64);

    const isValid = verifyMerkleProof(tree.root, corruptedProof, leaves[0]);
    expect(isValid).to.be.false;
  });

  it("should reject cross-proof swapping between different leaves", () => {
    // Attempting to verify leaf 0 using proof of leaf 1
    const isValid = verifyMerkleProof(tree.root, tree.proofs[1], leaves[0]);
    expect(isValid).to.be.false;
  });

  it("should reject valid proofs tested against a divergent or fake root", () => {
    const divergentLeaves = createMockLeaves(4).map((h) =>
      keccak256(toUtf8Bytes(h + "-divergent")),
    );
    const divergentTree = buildMerkleTree(divergentLeaves);

    // Verify proof from tree against divergent root
    const isValid = verifyMerkleProof(
      divergentTree.root,
      tree.proofs[0],
      leaves[0],
    );
    expect(isValid).to.be.false;
  });

  it("should validate input constraints and handle malformed inputs", () => {
    // buildMerkleTree errors on empty array
    expect(() => buildMerkleTree([])).to.throw(
      "Cannot build Merkle tree from empty leaves array",
    );

    // buildMerkleTree errors on invalid 32-byte hex elements
    expect(() => buildMerkleTree(["0x1234"])).to.throw(
      "Invalid 32-byte hex leaf at index 0",
    );

    // verifyMerkleProof returns false on invalid inputs
    expect(verifyMerkleProof("invalid-root", [], "0x1234")).to.be.false;
    expect(
      verifyMerkleProof(
        "0x" + "a".repeat(64),
        ["invalid-proof-hash"],
        "0x" + "b".repeat(64),
      ),
    ).to.be.false;
  });
});
