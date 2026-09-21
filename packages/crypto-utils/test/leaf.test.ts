import { expect } from "chai";
import { AbiCoder, getAddress, isHexString, keccak256, toUtf8Bytes } from "ethers";
import { describe, it } from "node:test";
import { canonicalize } from "../src/canonicalizer.ts";
import {
  computeLeafHash,
  hashPayloadData,
  type ComputeLeafHashInput,
} from "../src/leaf.ts";

const defaultAbiCoder = AbiCoder.defaultAbiCoder();

const BASE_INPUT: ComputeLeafHashInput = {
  id: 1,
  entityId: 1,
  recordType: "prescription",
  data: { drug: "amoxicillin", dose: "500mg" },
  version: 1,
  isDeleted: false,
  replaces: null,
  clientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  signature:
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function expectedLeaf(input: ComputeLeafHashInput): string {
  const dataHash = hashPayloadData(input.data);
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
      input.id,
      input.entityId,
      input.recordType,
      dataHash,
      input.version,
      input.isDeleted,
      input.replaces ?? 0,
      getAddress(input.clientAddress),
      input.signature,
      Math.floor(input.createdAt.getTime() / 1000),
    ],
  );
  return keccak256(encoded);
}

describe("leaf", () => {
  it("should compute the keccak256 hash of canonicalized payload data", () => {
    const payload = { z: { y: 2, x: 1 }, a: [3, 2, 1] };
    const expectedHash = keccak256(toUtf8Bytes(canonicalize(payload)));
    expect(hashPayloadData(payload)).to.equal(expectedHash);
    expect(isHexString(hashPayloadData(payload), 32)).to.be.true;
  });

  it("should compute the leaf hash using EVM ABI encoding correctly, binding every field", () => {
    const computed = computeLeafHash(BASE_INPUT);
    expect(computed).to.equal(expectedLeaf(BASE_INPUT));
    expect(isHexString(computed, 32)).to.be.true;
  });

  it("should generate deterministic leaf hash regardless of payload key order", () => {
    const leafA = computeLeafHash({
      ...BASE_INPUT,
      data: { role: "admin", department: "IT" },
    });
    const leafB = computeLeafHash({
      ...BASE_INPUT,
      data: { department: "IT", role: "admin" },
    });
    expect(leafA).to.equal(leafB);
  });

  it("should produce the same leaf hash for numeric and string representations of id/entityId/version", () => {
    const fromNumbers = computeLeafHash({
      ...BASE_INPUT,
      id: 42,
      entityId: 7,
      version: 3,
    });
    const fromStrings = computeLeafHash({
      ...BASE_INPUT,
      id: "42",
      entityId: "7",
      version: "3",
    });
    expect(fromNumbers).to.equal(fromStrings);
  });

  it("should produce the same leaf hash regardless of clientAddress casing", () => {
    const checksummed = computeLeafHash({
      ...BASE_INPUT,
      clientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    });
    const lowercase = computeLeafHash({
      ...BASE_INPUT,
      clientAddress: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    });
    expect(checksummed).to.equal(lowercase);
  });

  it("should encode a null replaces the same as the 0 sentinel", () => {
    const withNull = computeLeafHash({ ...BASE_INPUT, replaces: null });
    const withZero = computeLeafHash({ ...BASE_INPUT, replaces: 0 });
    expect(withNull).to.equal(withZero);
  });

  it("should throw an error if signature is empty or whitespace", () => {
    expect(() => computeLeafHash({ ...BASE_INPUT, signature: "" })).to.throw(
      "Invalid signature: signature cannot be empty",
    );
    expect(() =>
      computeLeafHash({ ...BASE_INPUT, signature: "   " }),
    ).to.throw("Invalid signature: signature cannot be empty");
  });

  it("should throw for a malformed clientAddress", () => {
    expect(() =>
      computeLeafHash({ ...BASE_INPUT, clientAddress: "not-an-address" }),
    ).to.throw();
  });

  // The whole point of this widening: changing any one field alone must
  // change the leaf, so tampering with it after anchoring is detectable.
  const fieldChanges: Array<[string, Partial<ComputeLeafHashInput>]> = [
    ["id", { id: 999 }],
    ["entityId", { entityId: 999 }],
    ["recordType", { recordType: "emr_encounter" }],
    ["data", { data: { drug: "ibuprofen" } }],
    ["version", { version: 2 }],
    ["isDeleted", { isDeleted: true }],
    ["replaces", { replaces: 5 }],
    [
      "clientAddress",
      { clientAddress: "0x000000000000000000000000000000000000dEaD" },
    ],
    ["signature", { signature: `0x${"1".repeat(130)}` }],
    ["createdAt", { createdAt: new Date("2027-01-01T00:00:00.000Z") }],
  ];

  for (const [field, change] of fieldChanges) {
    it(`should produce a divergent leaf hash when ${field} changes`, () => {
      const original = computeLeafHash(BASE_INPUT);
      const tampered = computeLeafHash({ ...BASE_INPUT, ...change });
      expect(original).to.not.equal(tampered);
    });
  }
});
