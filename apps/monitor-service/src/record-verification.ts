import { computeLeafHash, verifyMerkleProof } from "crypto-utils";
import type { AnchorableRecord } from "service-runtime";

export interface RecordVerification {
  recordId: number;
  verified: boolean;
}

/**
 * Recomputes a record's leaf from its current raw `records` columns (the
 * untrusted value that must be independently rebuilt every audit cycle,
 * never read from a precomputed hash) and checks it against the proof
 * captured at anchor time plus the batch's on-chain root. A record whose
 * data was edited after anchoring fails here even though every other
 * record in the batch still passes.
 */
export function verifyAnchoredRecord(
  record: AnchorableRecord,
  proof: string[],
  onChainRoot: string,
): RecordVerification {
  try {
    const leaf = computeLeafHash({
      id: record.id,
      entityId: record.entityId,
      recordType: record.recordType,
      data: record.payload,
      version: record.version,
      isDeleted: record.isDeleted,
      replaces: record.replaces,
      clientAddress: record.clientAddress,
      signature: record.signature,
      createdAt: record.createdAt,
    });

    return {
      recordId: record.id,
      verified: verifyMerkleProof(onChainRoot, proof, leaf),
    };
  } catch {
    /**
     * computeLeafHash throws on a malformed clientAddress or signature (ethers's
     * getAddress) — exactly the shape a privileged actor's direct row edit could
     * produce. Reported as a normal tamper finding, matching verifyMerkleProof's
     * own never-throws contract, instead of crashing the whole batch's audit.
     */
    return { recordId: record.id, verified: false };
  }
}
