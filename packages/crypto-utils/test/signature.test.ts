import { expect } from "chai";
import { HDNodeWallet, Wallet } from "ethers";
import { beforeEach, describe, it } from "node:test";
import { canonicalize } from "../src/canonicalizer.ts";
import {
  isWhitelistedAddress,
  recoverSignerAddress,
  verifyClientSignature,
  type SignableRecordContent,
} from "../src/signature.ts";

describe("signature verification", () => {
  let wallet: HDNodeWallet;

  const BASE_CONTENT: SignableRecordContent = {
    recordType: "prescription",
    data: { drug: "amoxicillin", dose: "500mg" },
    version: 1,
    isDeleted: false,
    replaces: null,
    entityId: null,
  };

  beforeEach(async () => {
    wallet = Wallet.createRandom();
  });

  async function sign(content: SignableRecordContent, signer = wallet) {
    return signer.signMessage(canonicalize(content));
  }

  it("should recover the signer address from a valid signature with a real wallet", async () => {
    const signature = await sign(BASE_CONTENT);
    const recoveredAddress = recoverSignerAddress(BASE_CONTENT, signature);

    expect(recoveredAddress).to.equal(wallet.address);
  });

  it("should verify valid client signature regardless of property order in data", async () => {
    const originalContent = {
      ...BASE_CONTENT,
      data: { name: "Daniel", role: "Auditor", active: true },
    };
    const signature = await sign(originalContent);

    const shuffledContent = {
      ...BASE_CONTENT,
      data: { active: true, role: "Auditor", name: "Daniel" },
    };

    const isValid = verifyClientSignature({
      ...shuffledContent,
      signature,
      clientAddress: wallet.address,
    });

    expect(isValid).to.be.true;
  });

  it("should reject tampered data and return false", async () => {
    const signature = await sign(BASE_CONTENT);

    const isValid = verifyClientSignature({
      ...BASE_CONTENT,
      data: { ...BASE_CONTENT.data, dose: "9999mg" },
      signature,
      clientAddress: wallet.address,
    });

    expect(isValid).to.be.false;
  });

  it("should reject impostor clientAddress", async () => {
    const attackerWallet = Wallet.createRandom();
    const signature = await sign(BASE_CONTENT);

    const isValid = verifyClientSignature({
      ...BASE_CONTENT,
      signature,
      clientAddress: attackerWallet.address,
    });

    expect(isValid).to.be.false;
  });

  it("should handle lowercase and checksummed addresses seamlessly (case-insensitive)", async () => {
    const signature = await sign(BASE_CONTENT);

    expect(
      verifyClientSignature({
        ...BASE_CONTENT,
        signature,
        clientAddress: wallet.address.toLowerCase(),
      }),
    ).to.be.true;

    expect(
      verifyClientSignature({
        ...BASE_CONTENT,
        signature,
        clientAddress: wallet.address,
      }),
    ).to.be.true;
  });

  it("should handle malformed or corrupted signatures without crashing", () => {
    expect(
      verifyClientSignature({
        ...BASE_CONTENT,
        signature: "0x1234",
        clientAddress: wallet.address,
      }),
    ).to.be.false;

    expect(
      verifyClientSignature({
        ...BASE_CONTENT,
        signature: "not-a-valid-hex-signature",
        clientAddress: wallet.address,
      }),
    ).to.be.false;

    expect(() => recoverSignerAddress(BASE_CONTENT, "0x1234")).to.throw();
  });

  it("should return false for incomplete or invalid payloads", () => {
    expect(
      verifyClientSignature({
        ...BASE_CONTENT,
        signature: "",
        clientAddress: wallet.address,
      }),
    ).to.be.false;

    expect(
      verifyClientSignature({
        ...BASE_CONTENT,
        signature: "0x1234",
        clientAddress: "",
      }),
    ).to.be.false;
  });

  // The whole point of this widening: tampering any of these fields after
  // signing must now be caught by the signature check itself, before the
  // record ever reaches a Merkle leaf.
  const fieldChanges: Array<[string, Partial<SignableRecordContent>]> = [
    ["recordType", { recordType: "emr_encounter" }],
    ["version", { version: 3 }],
    ["isDeleted", { isDeleted: true }],
    ["replaces", { replaces: 7 }],
    ["entityId", { entityId: 999 }],
  ];

  for (const [field, change] of fieldChanges) {
    it(`should reject a record whose ${field} changed after signing`, async () => {
      const signature = await sign(BASE_CONTENT);

      const isValid = verifyClientSignature({
        ...BASE_CONTENT,
        ...change,
        signature,
        clientAddress: wallet.address,
      });

      expect(isValid).to.be.false;
    });
  }

  it("should validate whitelist addresses accurately with checksum support", () => {
    const allowedAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const unauthorizedAddress = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

    const whitelist = [
      "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      "invalid-entry",
    ];

    expect(isWhitelistedAddress(allowedAddress, whitelist)).to.be.true;
    expect(isWhitelistedAddress(allowedAddress.toLowerCase(), whitelist)).to.be
      .true;
    expect(isWhitelistedAddress(unauthorizedAddress, whitelist)).to.be.false;
    expect(isWhitelistedAddress("not-an-address", whitelist)).to.be.false;
  });
});
