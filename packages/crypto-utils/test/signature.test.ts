import { expect } from "chai";
import { HDNodeWallet, Wallet } from "ethers";
import { beforeEach, describe, it } from "node:test";
import { canonicalize } from "../src/canonicalizer.ts";
import {
  isWhitelistedAddress,
  recoverSignerAddress,
  verifyClientSignature,
} from "../src/signature.ts";

describe("signature verification", () => {
  let wallet: HDNodeWallet;

  beforeEach(async () => {
    wallet = Wallet.createRandom();
  });

  it("should recover the signer address from valid signature with a real wallet", async () => {
    const data = {
      operation: "CREATE_RECORD",
      amount: 2500,
      user: "Test User",
    };
    const signature = await wallet.signMessage(canonicalize(data));
    const recoveredAddress = recoverSignerAddress(data, signature);

    expect(recoveredAddress.toLowerCase()).to.equal(
      wallet.address.toLowerCase(),
    );
    expect(recoveredAddress).to.equal(wallet.address);
  });

  it("should verify valid client signature regardless of property order in data", async () => {
    const originalData = { name: "Daniel", role: "Auditor", active: true };
    const signature = await wallet.signMessage(canonicalize(originalData));

    const shuffledData = { active: true, role: "Auditor", name: "Daniel" };

    const isValid = verifyClientSignature({
      id: "rec-01",
      data: shuffledData,
      signature,
      clientAddress: wallet.address,
    });

    expect(isValid).to.be.true;
  });

  it("should reject tampered data and return false", async () => {
    const data = { salary: 5000, recipient: "Arthur" };
    const signature = await wallet.signMessage(canonicalize(data));
    const tamperedData = { salary: 90000, recipient: "Arthur" };

    const isValid = verifyClientSignature({
      id: "rec-02",
      data: tamperedData,
      signature,
      clientAddress: wallet.address,
    });

    expect(isValid).to.be.false;
  });

  it("should reject impostor clientAddress", async () => {
    const legitimateWallet = wallet;
    const attackerWallet = Wallet.createRandom();
    const data = { action: "TRANSFER", to: "0xabc", value: 100 };
    const signature = await legitimateWallet.signMessage(canonicalize(data));

    // Payload claims to be attacker's address
    const isValid = verifyClientSignature({
      id: "rec-03",
      data,
      signature,
      clientAddress: attackerWallet.address,
    });

    expect(isValid).to.be.false;
  });

  it("should handle lowercase and checksummed addresses seamlessly (case-insensitive)", async () => {
    const data = { action: "APPROVE" };
    const signature = await wallet.signMessage(canonicalize(data));
    const lowercaseAddress = wallet.address.toLowerCase();
    const checksummedAddress = wallet.address;

    const isValidLower = verifyClientSignature({
      id: "rec-04",
      data,
      signature,
      clientAddress: lowercaseAddress,
    });

    const isValidChecksum = verifyClientSignature({
      id: "rec-04",
      data,
      signature,
      clientAddress: checksummedAddress,
    });

    expect(isValidLower).to.be.true;
    expect(isValidChecksum).to.be.true;
  });

  it("should handle malformed or corrupted signatures without crashing", () => {
    const data = { valid: true };

    const resultCorrupted = verifyClientSignature({
      id: "rec-05",
      data,
      signature: "0x1234",
      clientAddress: wallet.address,
    });

    const resultInvalidHex = verifyClientSignature({
      id: "rec-05",
      data,
      signature: "not-a-valid-hex-signature",
      clientAddress: wallet.address,
    });

    expect(resultCorrupted).to.be.false;
    expect(resultInvalidHex).to.be.false;

    expect(() => recoverSignerAddress(data, "0x1234")).to.throw();
  });

  it("should return false for incomplete or invalid payloads", () => {
    const data = { test: true };

    expect(
      verifyClientSignature({
        id: "1",
        data,
        signature: "",
        clientAddress: wallet.address,
      }),
    ).to.be.false;

    expect(
      verifyClientSignature({
        id: "1",
        data,
        signature: "0x1234",
        clientAddress: "",
      }),
    ).to.be.false;
  });

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
