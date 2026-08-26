export type RecordType = "prescription" | "emr_encounter";

export interface RecordRow {
  id: number;
  entityId: number;
  recordType: RecordType;
  data: Record<string, unknown>;
  version: number;
  isDeleted: boolean;
  replaces: number | null;
  clientAddress: string;
  signature: string;
  createdAt: string;
}
