/**
 * Everything about a record a client can know and sign for in advance —
 * every field except `id`/`createdAt`/`entityId`-on-create, which the
 * database only mints after the client has already signed.
 */
export interface SignableRecordContent {
  recordType: string;
  data: Record<string, unknown>;
  version: number;
  isDeleted: boolean;
  replaces: number | null;
  entityId: number | null;
}

/**
 * Represents the data payload of a record submitted by a client.
 */
export interface RecordPayload extends SignableRecordContent {
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
