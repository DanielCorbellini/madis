import {
  getMerkleAnchorRegistry,
  MerkleAnchorRegistry__factory,
} from "contracts-shared";
import { JsonRpcProvider } from "ethers";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// A non-routable RPC URL: the provider is constructed but never contacted, since
// every assertion below is a purely local operation (interface binding only).
const DUMMY_RPC = "http://127.0.0.1:0";
const DUMMY_ADDRESS = "0x0000000000000000000000000000000000000001";

describe("contracts-shared", () => {
  it("exposes the generated MerkleAnchorRegistry factory with its ABI", () => {
    assert.equal(typeof MerkleAnchorRegistry__factory.connect, "function");
    assert.ok(Array.isArray(MerkleAnchorRegistry__factory.abi));
    const names = MerkleAnchorRegistry__factory.abi
      .filter((entry) => entry.type === "function")
      .map((entry) => entry.name);
    assert.ok(names.includes("addMerkleRoot"));
    assert.ok(names.includes("containsMerkleRoot"));
  });

  it("getMerkleAnchorRegistry binds a typed contract to an address + runner", () => {
    const provider = new JsonRpcProvider(DUMMY_RPC);
    const registry = getMerkleAnchorRegistry(DUMMY_ADDRESS, provider);

    assert.equal(registry.target, DUMMY_ADDRESS);
    assert.equal(typeof registry.addMerkleRoot, "function");
    assert.equal(typeof registry.containsMerkleRoot, "function");
    assert.equal(typeof registry.getRootCount, "function");
    assert.equal(typeof registry.filters.RootAdded, "function");
  });
});
