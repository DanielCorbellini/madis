import { expect } from "chai";
import { describe, it } from "node:test";
import { canonicalize } from "../src/canonicalizer.ts";

describe("canonicalizer", () => {
  it("should sort Web3 record payloads deterministically regardless of key insertion order", () => {
    const originalPayload = {
      clientAddress: "0x1234567890abcdef1234567890abcdef12345678",
      signature:
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
      data: {
        z: { y: 2, x: 1 },
        a: [3, 2, 1],
      },
    };

    const shuffledPayload = {
      data: {
        a: [3, 2, 1],
        z: { x: 1, y: 2 },
      },
      signature:
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
      clientAddress: "0x1234567890abcdef1234567890abcdef12345678",
    };

    const expected =
      '{"clientAddress":"0x1234567890abcdef1234567890abcdef12345678","data":{"a":[3,2,1],"z":{"x":1,"y":2}},"signature":"0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef"}';

    expect(canonicalize(originalPayload)).to.equal(expected);
    expect(canonicalize(shuffledPayload)).to.equal(expected);
    expect(canonicalize(originalPayload)).to.equal(
      canonicalize(shuffledPayload),
    );
  });

  it("should handle records with nested attributes and diverse types", () => {
    const recordA = {
      employeeId: "EMP-1042",
      name: "Test User",
      salary: 8750.5,
      active: true,
      department: { code: "TI-SEC", name: "Information Security" },
      roles: ["auditor", "admin"],
    };

    const recordB = {
      roles: ["auditor", "admin"],
      department: { name: "Information Security", code: "TI-SEC" },
      active: true,
      salary: 8750.5,
      name: "Test User",
      employeeId: "EMP-1042",
    };

    expect(canonicalize(recordA)).to.equal(canonicalize(recordB));
  });

  it("should canonicalize objects inside arrays while preserving array element order", () => {
    const listA = [
      { b: 2, a: 1 },
      { d: 4, c: 3 },
    ];
    const listB = [
      { a: 1, b: 2 },
      { c: 3, d: 4 },
    ];

    expect(canonicalize(listA)).to.equal('[{"a":1,"b":2},{"c":3,"d":4}]');
    expect(canonicalize(listA)).to.equal(canonicalize(listB));
  });

  it("should NOT sort array primitive elements because array order is semantic", () => {
    const ordered = [1, 2, 3];
    const reversed = [3, 2, 1];

    expect(canonicalize(ordered)).to.equal("[1,2,3]");
    expect(canonicalize(reversed)).to.equal("[3,2,1]");
    expect(canonicalize(ordered)).to.not.equal(canonicalize(reversed));
  });

  it("should handle special characters, UTF-8 strings, line breaks and escapes cleanly", () => {
    const specialData = {
      city: "São Paulo",
      description: 'Record with "quotes" and\nline break',
      unicodeSymbol: "🔐 Merkle Tree",
    };

    const canonical = canonicalize(specialData);
    expect(canonical).to.include('"city":"São Paulo"');
    expect(canonical).to.include('\\"quotes\\"');
    expect(canonical).to.include("🔐 Merkle Tree");
  });

  it("should handle empty objects, empty arrays, null and primitive types", () => {
    expect(canonicalize({})).to.equal("{}");
    expect(canonicalize([])).to.equal("[]");
    expect(canonicalize({ a: {}, b: [] })).to.equal('{"a":{},"b":[]}');
    expect(canonicalize(null)).to.equal("null");
    expect(canonicalize(0)).to.equal("0");
    expect(canonicalize(false)).to.equal("false");
    expect(canonicalize("")).to.equal('""');
  });

  it("should omit undefined object properties to comply with standard JSON format", () => {
    const objWithUndefined = {
      validKey: "value",
      ignoredKey: undefined,
    };

    expect(canonicalize(objWithUndefined)).to.equal('{"validKey":"value"}');
  });
});
