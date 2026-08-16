import { expect } from "chai";
import { HDNodeWallet, isHexString, Wallet } from "ethers";
import { beforeEach, describe, it } from "node:test";
import {
  buildMerkleTree,
  canonicalize,
  computeLeafHash,
  isWhitelistedAddress,
  verifyClientSignature,
  verifyMerkleProof,
} from "../src/index.ts";
import type { RecordPayload } from "../src/types.ts";

describe("E2E Crypto Pipeline & Security Integration", () => {
  let authorizedClientA: HDNodeWallet;
  let authorizedClientB: HDNodeWallet;
  let attackerWallet: HDNodeWallet;
  let whitelist: string[];

  beforeEach(() => {
    authorizedClientA = Wallet.createRandom();
    authorizedClientB = Wallet.createRandom();
    attackerWallet = Wallet.createRandom();

    whitelist = [
      authorizedClientA.address.toLowerCase(),
      authorizedClientB.address,
    ];
  });

  it("should execute the full lifecycle: client signing -> API verification -> batch anchoring -> audit verification", async () => {
    // 1. Client Domain: Preparing and signing records
    const rawRecords = [
      {
        id: "rec-101",
        data: { employee: "Daniel", salary: 7500, department: "Security" },
        client: authorizedClientA,
      },
      {
        id: "rec-102",
        data: { employee: "Diana", salary: 8200, department: "Engineering" },
        client: authorizedClientA,
      },
      {
        id: "rec-103",
        data: { employee: "Arthur", salary: 6900, department: "DevOps" },
        client: authorizedClientB,
      },
      {
        id: "rec-104",
        data: { employee: "David", salary: 9100, department: "Management" },
        client: authorizedClientB,
      },
    ];

    const signedPayloads: RecordPayload[] = await Promise.all(
      rawRecords.map(async (r) => {
        const canonicalData = canonicalize(r.data);
        const signature = await r.client.signMessage(canonicalData);
        return {
          id: r.id,
          data: r.data,
          signature,
          clientAddress: r.client.address,
        };
      }),
    );

    // 2. Data Domain (API Ingestion): Whitelist and signature checks
    for (const payload of signedPayloads) {
      expect(isWhitelistedAddress(payload.clientAddress, whitelist)).to.be.true;
      expect(verifyClientSignature(payload)).to.be.true;
    }

    // 3. Anchor Daemon: Computing leaves and building Merkle Tree
    const leaves = signedPayloads.map((p) =>
      computeLeafHash(p.id, p.data, p.signature),
    );

    const { root, proofs } = buildMerkleTree(leaves);

    expect(isHexString(root, 32)).to.be.true;
    expect(proofs).to.have.lengthOf(signedPayloads.length);

    // 4. Monitor Daemon (Audit Flow): Verifying all proofs against the on-chain root
    for (let i = 0; i < leaves.length; i++) {
      const isProofValid = verifyMerkleProof(root, proofs[i], leaves[i]);
      expect(isProofValid).to.be.true;
    }
  });

  it("should isolate and detect a SQL data tampering attack on a single row", async () => {
    // 1. Create and anchor a batch of 4 records
    const rawRecords = [
      { id: "row-1", data: { account: "A1", balance: 1000 } },
      { id: "row-2", data: { account: "A2", balance: 2000 } },
      { id: "row-3", data: { account: "A3", balance: 5000 } },
      { id: "row-4", data: { account: "A4", balance: 4000 } },
    ];

    const batch = await Promise.all(
      rawRecords.map(async (r) => {
        const signature = await authorizedClientA.signMessage(
          canonicalize(r.data),
        );
        return {
          id: r.id,
          data: r.data,
          signature,
          clientAddress: authorizedClientA.address,
        };
      }),
    );

    const originalLeaves = batch.map((r) =>
      computeLeafHash(r.id, r.data, r.signature),
    );
    const { root: officialRoot, proofs: originalProofs } =
      buildMerkleTree(originalLeaves);

    // 2. Simulating Malicious DBA: Tampering ONLY Row #3 in PostgreSQL
    const databaseRows = [
      { ...batch[0] },
      { ...batch[1] },
      {
        ...batch[2],
        data: { account: "A3", balance: 95000 }, // FRAUD: balance increased from 5000 to 95000
      },
      { ...batch[3] },
    ];

    // 3. Monitor Daemon: Recalculates leaves from raw database records
    const auditedLeaves = databaseRows.map((row) =>
      computeLeafHash(row.id, row.data, row.signature),
    );

    // A. Reconstructing the Merkle Tree results in a DIVERGENT Root
    const reconstructedTree = buildMerkleTree(auditedLeaves);
    expect(reconstructedTree.root).to.not.equal(officialRoot);

    // B. Proving integrity of unaffected rows (#1, #2, #4)
    expect(verifyMerkleProof(officialRoot, originalProofs[0], auditedLeaves[0]))
      .to.be.true;
    expect(verifyMerkleProof(officialRoot, originalProofs[1], auditedLeaves[1]))
      .to.be.true;
    expect(verifyMerkleProof(officialRoot, originalProofs[3], auditedLeaves[3]))
      .to.be.true;

    // C. Pinpointing the EXACT tampered row (#3)
    expect(verifyMerkleProof(officialRoot, originalProofs[2], auditedLeaves[2]))
      .to.be.false;
  });

  it("should prevent complete insider forgery (attacker modifying data, signature and address simultaneously)", async () => {
    // 1. Legitimate original record anchored on blockchain
    const originalData = { contractId: "CT-2026", approvedBudget: 50000 };
    const originalSignature = await authorizedClientA.signMessage(
      canonicalize(originalData),
    );
    const originalLeaf = computeLeafHash(
      "ct-1",
      originalData,
      originalSignature,
    );
    const { root: anchoredRoot, proofs } = buildMerkleTree([
      originalLeaf,
      computeLeafHash("dummy", { d: 1 }, "0x" + "1".repeat(130)),
    ]);

    // 2. Attacker modifies data, signs with attackerWallet, and updates clientAddress in DB
    const forgedData = { contractId: "CT-2026", approvedBudget: 500000 };
    const forgedSignature = await attackerWallet.signMessage(
      canonicalize(forgedData),
    );

    const forgedRow: RecordPayload = {
      id: "ct-1",
      data: forgedData,
      signature: forgedSignature,
      clientAddress: attackerWallet.address,
    };

    // 3. Validation Analysis:
    // A. Whitelist check FAILS for unauthorized attacker address
    expect(isWhitelistedAddress(forgedRow.clientAddress, whitelist)).to.be
      .false;

    // B. Recalculated leaf FAILS against the immutable on-chain Merkle Root
    const forgedLeaf = computeLeafHash(
      forgedRow.id,
      forgedRow.data,
      forgedRow.signature,
    );
    const isProofValidOnAnchoredRoot = verifyMerkleProof(
      anchoredRoot,
      proofs[0],
      forgedLeaf,
    );

    expect(isProofValidOnAnchoredRoot).to.be.false;
  });

  it("should maintain full deterministic parity when key order is shuffled between ingestion and audit", async () => {
    // 1. Client sends JSON with keys in arbitrary order
    const clientJson = {
      notes: "Audit approval",
      department: "Finance",
      amount: 15000,
      active: true,
    };
    const signature = await authorizedClientA.signMessage(
      canonicalize(clientJson),
    );

    // 2. Database stores and returns keys in different order
    const dbJson = {
      amount: 15000,
      active: true,
      notes: "Audit approval",
      department: "Finance",
    };

    // 3. Verification passes transparently
    const isSigValid = verifyClientSignature({
      id: "doc-99",
      data: dbJson,
      signature,
      clientAddress: authorizedClientA.address,
    });
    expect(isSigValid).to.be.true;

    // 4. Leaf hash remains 100% identical
    const leafClient = computeLeafHash("doc-99", clientJson, signature);
    const leafDb = computeLeafHash("doc-99", dbJson, signature);
    expect(leafClient).to.equal(leafDb);
  });
});
