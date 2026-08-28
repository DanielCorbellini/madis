import type { RecordRow, RecordType } from "./record-types.ts";

export interface Queryable {
  query(text: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface CreateEntityInput {
  recordType: RecordType;
  data: Record<string, unknown>;
  clientAddress: string;
  signature: string;
}

export interface AppendVersionInput {
  recordType: RecordType;
  entityId: number;
  data: Record<string, unknown>;
  clientAddress: string;
  signature: string;
  replaces: number;
  version: number;
  isDeleted: boolean;
}

export interface ListLatestOptions {
  after?: number;
  limit: number;
}

export interface RecordRepository {
  createEntity(input: CreateEntityInput): Promise<RecordRow>;
  appendVersion(input: AppendVersionInput): Promise<RecordRow>;
  findLatest(
    recordType: RecordType,
    entityId: number,
  ): Promise<RecordRow | null>;
  findHistory(recordType: RecordType, entityId: number): Promise<RecordRow[]>;
  listLatest(
    recordType: RecordType,
    options: ListLatestOptions,
  ): Promise<RecordRow[]>;
}

export class VersionConflictDbError extends Error {}

const UNIQUE_VIOLATION = "23505";

const SELECT_COLUMNS = `
  id,
  entity_id AS "entityId",
  record_type AS "recordType",
  payload AS data,
  version,
  is_deleted AS "isDeleted",
  replaces,
  client_address AS "clientAddress",
  signature, 
  created_at AS "createdAt"
`;

interface RecordRowDb {
  id: string;
  entityId: string;
  recordType: RecordType;
  data: Record<string, unknown>;
  version: number;
  isDeleted: boolean;
  replaces: string | null;
  clientAddress: string;
  signature: string;
  createdAt: Date | string;
}

// node-postgres returns BIGINT columns (records.id, entity_id, replaces) as
// strings to avoid precision loss, so every row from the DB needs this
// conversion before it matches RecordRow's `number` fields.
function toRecordRow(row: RecordRowDb): RecordRow {
  return {
    id: Number(row.id),
    entityId: Number(row.entityId),
    recordType: row.recordType,
    data: row.data,
    version: row.version,
    isDeleted: row.isDeleted,
    replaces: row.replaces === null ? null : Number(row.replaces),
    clientAddress: row.clientAddress,
    signature: row.signature,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === UNIQUE_VIOLATION
  );
}

export function createPostgresRecordRepository(
  db: Queryable,
): RecordRepository {
  return {
    async createEntity(input) {
      const result = await db.query(
        `
          WITH
              next_id AS (
                  SELECT
                      nextval ('records_id_seq') AS id
              )
          INSERT INTO
              records (
                  id,
                  entity_id,
                  record_type,
                  payload,
                  version,
                  client_address,
                  signature
              )
          SELECT
              id,
              id,
              $1,
              $2,
              1,
              $3,
              $4
          FROM
              next_id RETURNING ${SELECT_COLUMNS}
        `,
        [input.recordType, input.data, input.clientAddress, input.signature],
      );
      return toRecordRow(result.rows[0] as RecordRowDb);
    },

    async appendVersion(input) {
      try {
        const result = await db.query(
          `
            INSERT INTO
                records (
                    entity_id,
                    record_type,
                    payload,
                    version,
                    replaces,
                    is_deleted,
                    client_address,
                    signature
                )
            VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${SELECT_COLUMNS}
          `,
          [
            input.entityId,
            input.recordType,
            input.data,
            input.version,
            input.replaces,
            input.isDeleted,
            input.clientAddress,
            input.signature,
          ],
        );
        return toRecordRow(result.rows[0] as RecordRowDb);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new VersionConflictDbError(
            `entity ${input.entityId} already has a version ${input.version} row`,
          );
        }
        throw error;
      }
    },

    async findLatest(recordType, entityId) {
      const result = await db.query(
        `
          SELECT
              ${SELECT_COLUMNS}
          FROM
              records
          WHERE
              record_type = $1
              AND entity_id = $2
          ORDER BY
              version DESC
          LIMIT
              1
        `,
        [recordType, entityId],
      );
      const row = result.rows[0] as RecordRowDb | undefined;
      return row ? toRecordRow(row) : null;
    },

    async findHistory(recordType, entityId) {
      const result = await db.query(
        `
          SELECT 
              ${SELECT_COLUMNS}
          FROM
              records
          WHERE
              record_type = $1 
              AND entity_id = $2
          ORDER BY
              version ASC
        `,
        [recordType, entityId],
      );
      return (result.rows as RecordRowDb[]).map(toRecordRow);
    },

    async listLatest(recordType, { after, limit }) {
      const result = await db.query(
        `
          SELECT
              *
          FROM
              (
                  SELECT DISTINCT
                      ON (entity_id) ${SELECT_COLUMNS}
                  FROM
                      records
                  WHERE
                      record_type = $1
                  ORDER BY
                      entity_id,
                      version DESC
              ) latest
          WHERE
              NOT "isDeleted"
              AND "entityId" > $2
          ORDER BY
              "entityId" ASC
          LIMIT
              $3
        `,
        [recordType, after ?? 0, limit + 1],
      );
      return (result.rows as RecordRowDb[]).map(toRecordRow);
    },
  };
}
