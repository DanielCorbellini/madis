import {
  computeLeafHash,
  isWhitelistedAddress,
  verifyClientSignature,
} from "crypto-utils";
import type { AnchorableRecord } from "service-runtime";

export type ValidationResult =
  | { recordId: number; ok: true; leaf: string }
  | { recordId: number; ok: false; reason: string };

/**
 * Re-checks a record before it enters a batch:
 *  1. The ECDSA signature must still match every field the client could
 *     know in advance (recordType, payload, version, isDeleted, replaces,
 *     and — for an update/delete — entityId), not just the payload and
 *     `client_address`. `version` is signed as the value the write becomes
 *     (e.g. 2, not the 1 it replaces), so it's read straight from the row —
 *     no derivation needed.
 *  2. The signer must be whitelisted.
 *
 * `id`, `createdAt`, and `entityId`-on-create can never be covered by any
 * client signature — the database only mints them after the client has
 * already signed — so tampering with those specifically remains outside
 * what this check can catch (see docs/overview/anchor-service's
 * pre-anchoring-tamper-window note).
 *
 * On success returns the Merkle leaf
 */
export function validateRecord(
  record: AnchorableRecord,
  whitelist: string[],
): ValidationResult {
  const isCreate = record.replaces === null;

  const signatureValid = verifyClientSignature({
    recordType: record.recordType,
    data: record.payload,
    version: record.version,
    isDeleted: record.isDeleted,
    replaces: record.replaces,
    entityId: isCreate ? null : record.entityId,
    signature: record.signature,
    clientAddress: record.clientAddress,
  });

  if (!signatureValid) {
    return {
      recordId: record.id,
      ok: false,
      reason: "signature does not match payload or client_address",
    };
  }

  if (!isWhitelistedAddress(record.clientAddress, whitelist)) {
    return {
      recordId: record.id,
      ok: false,
      reason: `signer ${record.clientAddress} is not whitelisted`,
    };
  }

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

  return { recordId: record.id, ok: true, leaf };
}
