import {
  deployments,
  merkleAnchorRegistryAddress,
} from "contracts-shared/deployments";
import { isAddress } from "ethers";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("deployments", () => {
  it("returns undefined for a chain with no registered deployment", () => {
    assert.equal(merkleAnchorRegistryAddress(999999), undefined);
  });

  it("holds a valid address for every registered chain", () => {
    for (const [chainId, entry] of Object.entries(deployments)) {
      assert.ok(
        isAddress(entry.MerkleAnchorRegistry),
        `chain ${chainId} has an invalid MerkleAnchorRegistry address`,
      );

      assert.equal(
        merkleAnchorRegistryAddress(Number(chainId)),
        entry.MerkleAnchorRegistry,
      );
    }
  });
});
