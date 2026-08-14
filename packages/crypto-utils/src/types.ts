/**
 * Represents the data payload of a record submitted by a client.
 */
export interface RecordPayload {
  id: string | number;
  data: Record<string, unknown>;
  signature: string;
  clientAddress: string;
}

/**
 * Result of building a Merkle Tree.
 */
export interface MerkleTreeBuildResult {
  root: string;
  leaves: string[];
  proofs: string[][];
}

/**
 * Parameters for mathematical validation of a Merkle proof.
 */
export interface MerkleProofValidation {
  root: string;
  proof: string[];
  leaf: string;
}
