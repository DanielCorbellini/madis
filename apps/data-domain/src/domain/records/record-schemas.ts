import { z } from "zod";

export const recordDataSchema = z
  .record(z.string(), z.unknown())
  .refine((data) => Object.keys(data).length > 0, {
    message: "data must be a non-empty object",
  });

export const deletionDataSchema = z.record(z.string(), z.unknown());

export const ethereumAddressSchema = z
  .string()
  .regex(
    /^0x[a-fA-F0-9]{40}$/,
    "clientAddress must be a 0x-prefixed 40-hex-character address",
  );

export const createRecordBodySchema = z.object({
  data: recordDataSchema,
  clientAddress: ethereumAddressSchema,
  signature: z.string().min(1, "signature must not be empty"),
});

export const updateRecordBodySchema = createRecordBodySchema.extend({
  replaces: z.number().int().positive(),
  expectedVersion: z.number().int().positive(),
});

export const deleteRecordBodySchema = z.object({
  data: deletionDataSchema,
  clientAddress: ethereumAddressSchema,
  signature: z.string().min(1, "signature must not be empty"),
  replaces: z.number().int().positive(),
  expectedVersion: z.number().int().positive(),
});

export const entityIdParamsSchema = z.object({
  entityId: z.coerce.number().int().positive(),
});

export const recordResponseSchema = z.object({
  id: z.number(),
  entityId: z.number(),
  recordType: z.enum(["prescription", "emr_encounter"]),
  version: z.number(),
  isDeleted: z.boolean(),
  data: z.record(z.string(), z.unknown()),
  clientAddress: z.string(),
  createdAt: z.string(),
});

export const recordListQuerySchema = z.object({
  after: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const recordListResponseSchema = z.object({
  data: recordResponseSchema.array(),
  nextCursor: z.number().nullable(),
});
