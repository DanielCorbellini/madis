export interface AnchorableRecord {
  id: number;
  payload: Record<string, unknown>;
  signature: string;
  clientAddress: string;
}

/**
 * The same columns as they come back from `pg` (BIGINT ids as strings, snake_case).
 */
export interface RecordRow {
  id: string;
  payload: Record<string, unknown>;
  signature: string;
  client_address: string;
}

export function toAnchorableRecord(row: RecordRow): AnchorableRecord {
  return {
    id: Number(row.id),
    payload: row.payload,
    signature: row.signature,
    clientAddress: row.client_address,
  };
}
