import {
  computeLeafHash,
  isWhitelistedAddress,
  verifyClientSignature,
} from "crypto-utils";
import type { AnchorableRecord } from "./record.ts";

export type ValidationResult =
  | { recordId: number; ok: true; leaf: string }
  | { recordId: number; ok: false; reason: string };

/**
 * Re-checks a record before it enters a batch:
 *  1. The ECDSA signature must still match the payload and `client_address`
 *  2. The signer must be whitelisted.
 *
 * On success returns the Merkle leaf
 */
export function validateRecord(
  record: AnchorableRecord,
  whitelist: string[],
): ValidationResult {
  const signatureValid = verifyClientSignature({
    id: String(record.id),
    data: record.payload,
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

  const leaf = computeLeafHash(
    String(record.id),
    record.payload,
    record.signature,
  );
  return { recordId: record.id, ok: true, leaf };
}
