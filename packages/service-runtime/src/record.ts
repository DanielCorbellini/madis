export interface AnchorableRecord {
  id: number;
  entityId: number;
  recordType: string;
  payload: Record<string, unknown>;
  version: number;
  isDeleted: boolean;
  replaces: number | null;
  clientAddress: string;
  signature: string;
  createdAt: Date;
}

/**
 * The same columns as they come back from `pg` (BIGINT ids as strings, snake_case).
 */
export interface RecordRow {
  id: string;
  entity_id: string;
  record_type: string;
  payload: Record<string, unknown>;
  version: number;
  is_deleted: boolean;
  replaces: string | null;
  client_address: string;
  signature: string;
  created_at: Date;
}

export function toAnchorableRecord(row: RecordRow): AnchorableRecord {
  return {
    id: Number(row.id),
    entityId: Number(row.entity_id),
    recordType: row.record_type,
    payload: row.payload,
    version: row.version,
    isDeleted: row.is_deleted,
    replaces: row.replaces === null ? null : Number(row.replaces),
    clientAddress: row.client_address,
    signature: row.signature,
    createdAt: row.created_at,
  };
}
