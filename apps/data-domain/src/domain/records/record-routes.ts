import { verifyClientSignature } from "crypto-utils";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { WhitelistChecker } from "../../auth/whitelist.ts";
import {
  AddressNotAuthorizedError,
  RecordNotFoundError,
  SignatureInvalidError,
  VersionConflictError,
} from "../../errors/app-errors.ts";
import {
  VersionConflictDbError,
  type RecordRepository,
} from "./record-repository.ts";
import {
  createRecordBodySchema,
  deleteRecordBodySchema,
  entityIdParamsSchema,
  recordListQuerySchema,
  recordListResponseSchema,
  recordResponseSchema,
  updateRecordBodySchema,
} from "./record-schemas.ts";
import type { RecordType } from "./record-types.ts";

export interface RecordRoutesOptions {
  recordType: RecordType;
  repository: RecordRepository;
  isClientAuthorized: WhitelistChecker;
}

export async function recordRoutes(
  app: FastifyInstance,
  options: RecordRoutesOptions,
): Promise<void> {
  const { recordType, repository, isClientAuthorized } = options;
  const server = app.withTypeProvider<ZodTypeProvider>();

  async function assertAuthorizedAndSigned(input: {
    data: Record<string, unknown>;
    clientAddress: string;
    signature: string;
  }): Promise<void> {
    if (!(await isClientAuthorized(input.clientAddress))) {
      throw new AddressNotAuthorizedError();
    }
    if (!verifyClientSignature({ id: input.clientAddress, ...input })) {
      throw new SignatureInvalidError();
    }
  }

  async function performAppend(input: {
    entityId: number;
    data: Record<string, unknown>;
    clientAddress: string;
    signature: string;
    replaces: number;
    expectedVersion: number;
    isDeleted: boolean;
  }) {
    await assertAuthorizedAndSigned({
      data: input.data,
      clientAddress: input.clientAddress,
      signature: input.signature,
    });

    const current = await repository.findLatest(recordType, input.entityId);
    if (!current) {
      throw new RecordNotFoundError();
    }

    if (
      current.id !== input.replaces ||
      current.version !== input.expectedVersion
    ) {
      throw new VersionConflictError(
        `expected version ${input.expectedVersion} (id ${input.replaces}) but current version is ${current.version} (id ${current.id})`,
      );
    }

    if (current.isDeleted) {
      throw new VersionConflictError(
        `entity ${input.entityId} has already been deleted`,
      );
    }

    try {
      return await repository.appendVersion({
        recordType,
        entityId: input.entityId,
        data: input.data,
        clientAddress: input.clientAddress,
        signature: input.signature,
        replaces: current.id,
        version: current.version + 1,
        isDeleted: input.isDeleted,
      });
    } catch (error) {
      if (error instanceof VersionConflictDbError) {
        throw new VersionConflictError(error.message);
      }
      throw error;
    }
  }

  server.post(
    "/",
    {
      schema: {
        body: createRecordBodySchema,
        response: { 201: recordResponseSchema },
      },
    },
    async (request, reply) => {
      const { data, clientAddress, signature } = request.body;
      await assertAuthorizedAndSigned({ data, clientAddress, signature });

      const record = await repository.createEntity({
        recordType,
        data,
        clientAddress,
        signature,
      });

      reply.status(201).send(record);
    },
  );

  server.get(
    "/",
    {
      schema: {
        querystring: recordListQuerySchema,
        response: { 200: recordListResponseSchema },
      },
    },
    async (request) => {
      const { after, limit } = request.query;
      const rows = await repository.listLatest(recordType, { after, limit });

      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore
        ? (data[data.length - 1]?.entityId ?? null)
        : null;

      return { data, nextCursor };
    },
  );

  server.get(
    "/:entityId",
    {
      schema: {
        params: entityIdParamsSchema,
        response: { 200: recordResponseSchema },
      },
    },
    async (request) => {
      const record = await repository.findLatest(
        recordType,
        request.params.entityId,
      );
      if (!record || record.isDeleted) {
        throw new RecordNotFoundError();
      }
      return record;
    },
  );

  server.get(
    "/:entityId/history",
    {
      schema: {
        params: entityIdParamsSchema,
        response: { 200: recordResponseSchema.array() },
      },
    },
    async (request) => {
      const history = await repository.findHistory(
        recordType,
        request.params.entityId,
      );
      if (history.length === 0) {
        throw new RecordNotFoundError();
      }
      return history;
    },
  );

  server.patch(
    "/:entityId",
    {
      schema: {
        params: entityIdParamsSchema,
        body: updateRecordBodySchema,
        response: { 200: recordResponseSchema },
      },
    },
    async (request) =>
      performAppend({
        entityId: request.params.entityId,
        data: request.body.data,
        clientAddress: request.body.clientAddress,
        signature: request.body.signature,
        replaces: request.body.replaces,
        expectedVersion: request.body.expectedVersion,
        isDeleted: false,
      }),
  );

  server.delete(
    "/:entityId",
    {
      schema: {
        params: entityIdParamsSchema,
        body: deleteRecordBodySchema,
        response: { 200: recordResponseSchema },
      },
    },
    async (request) =>
      performAppend({
        entityId: request.params.entityId,
        data: request.body.data,
        clientAddress: request.body.clientAddress,
        signature: request.body.signature,
        replaces: request.body.replaces,
        expectedVersion: request.body.expectedVersion,
        isDeleted: true,
      }),
  );
}
