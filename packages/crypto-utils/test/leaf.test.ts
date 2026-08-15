import { describe, it } from "node:test";
import { expect } from "chai";
import { hashPayloadData, computeLeafHash } from "../src/leaf.ts";
import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";
import { canonicalize } from "../src/canonicalizer.ts";

const defaultAbiCoder = AbiCoder.defaultAbiCoder();

describe("leaf", () => {
  it("should compute the keccak256 hash of canonicalized payload data", () => {
    const payload = {
      clientAddress: "0x1234567890abcdef1234567890abcdef12345678",
      signature:
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
      data: {
        z: { y: 2, x: 1 },
        a: [3, 2, 1],
      },
    };

    const expectedHash = keccak256(toUtf8Bytes(canonicalize(payload)));
    const computedHash = hashPayloadData(payload);

    expect(computedHash).to.equal(expectedHash);
    expect(computedHash).to.match(/^0x[a-fA-F0-9]{64}$/);
  });

  it("should compute the leaf hash Li using EVM ABI encoding correctly", () => {
    const id = "rec-101";
    const data = {
      employee: "Test User",
      salary: 5000,
    };
    const signature =
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef";

    const dataHash = hashPayloadData(data);
    const expectedLeafHash = keccak256(
      defaultAbiCoder.encode(
        ["string", "bytes32", "string"],
        [String(id), dataHash, signature],
      ),
    );

    const computedLeafHash = computeLeafHash(id, data, signature);

    expect(computedLeafHash).to.equal(expectedLeafHash);
    expect(computedLeafHash).to.match(/^0x[a-fA-F0-9]{64}$/);
  });

  it("should generate deterministic leaf hash regardless of data key order", () => {
    const id = "rec-102";
    const dataA = { role: "admin", department: "IT", active: true };
    const dataB = { active: true, department: "IT", role: "admin" };
    const signature = "0x" + "a".repeat(130);

    const leafA = computeLeafHash(id, dataA, signature);
    const leafB = computeLeafHash(id, dataB, signature);

    expect(leafA).to.equal(leafB);
  });

  it("should detect any data tampering and produce a divergent leaf hash", () => {
    const id = "rec-103";
    const originalData = { item: "Laptop", price: 3000 };
    const tamperedData = { item: "Laptop", price: 3001 };
    const signature = "0x" + "b".repeat(130);

    const originalLeaf = computeLeafHash(id, originalData, signature);
    const tamperedLeaf = computeLeafHash(id, tamperedData, signature);

    expect(originalLeaf).to.not.equal(tamperedLeaf);
  });

  it("should produce divergent leaf hash when id or signature changes", () => {
    const data = { action: "TRANSFER", amount: 100 };
    const sigA = "0x" + "1".repeat(130);
    const sigB = "0x" + "2".repeat(130);

    const leafId1 = computeLeafHash("1", data, sigA);
    const leafId2 = computeLeafHash("2", data, sigA);
    expect(leafId1).to.not.equal(leafId2);

    const leafSigA = computeLeafHash("1", data, sigA);
    const leafSigB = computeLeafHash("1", data, sigB);
    expect(leafSigA).to.not.equal(leafSigB);
  });

  it("should produce the same leaf hash for numeric and string representations of the same ID", () => {
    const data = { status: "ACTIVE" };
    const signature = "0x" + "c".repeat(130);

    const leafFromNumber = computeLeafHash(42, data, signature);
    const leafFromString = computeLeafHash("42", data, signature);

    expect(leafFromNumber).to.equal(leafFromString);
  });

  it("should throw an error if signature is empty or whitespace", () => {
    const data = { valid: true };

    expect(() => computeLeafHash("1", data, "")).to.throw(
      "Invalid signature: signature cannot be empty",
    );
    expect(() => computeLeafHash("1", data, "   ")).to.throw(
      "Invalid signature: signature cannot be empty",
    );
  });
});
