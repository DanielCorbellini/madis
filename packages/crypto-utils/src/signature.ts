import {
  computeAddress,
  getAddress,
  getBytes,
  hashMessage,
  isAddress,
  Signature,
} from "ethers";
import secp256k1 from "secp256k1";
import { canonicalize } from "./canonicalizer.ts";
import type { RecordPayload, SignableRecordContent } from "./types.ts";

export type { SignableRecordContent };

/**
 * Recovers the Ethereum address that signed the canonical representation of
 * a record's full signable content, every field a client can know in advance
 * (`recordType`, `version`, `isDeleted`, `replaces`, `entityId`), so
 * tampering with any of them before anchoring invalidates the signature instead
 * of silently passing through.
 */
export function recoverSignerAddress(
  content: SignableRecordContent,
  signature: string,
): string {
  const canonicalContent = canonicalize(content);
  const digest = getBytes(hashMessage(canonicalContent));

  const { r, s, yParity } = Signature.from(signature);
  const compactSignature = getBytes(r + s.slice(2)); // ecdsaRecover wants raw r||s, not ethers' r/s/v-encoded signature

  const publicKey = secp256k1.ecdsaRecover(
    compactSignature,
    yParity,
    digest,
    false,
  );
  return computeAddress(`0x${Buffer.from(publicKey).toString("hex")}`);
}

/**
 * Verifies whether the signature matches the clientAddress in the payload.
 * Checks if the address that signed the payload does not match the clientAddress, or if any of the required fields are missing, it returns false.
 */
export function verifyClientSignature(payload: RecordPayload): boolean {
  try {
    if (
      !payload.clientAddress ||
      !payload.signature ||
      !payload.data ||
      !payload.recordType
    ) {
      return false;
    }

    const { signature, clientAddress, ...content } = payload;
    const recoveredAddress = recoverSignerAddress(content, signature);

    return getAddress(recoveredAddress) === getAddress(clientAddress);
  } catch {
    return false;
  }
}

/**
 * Checks if an address is contained in the whitelist (case-insensitive checksum).
 */
export function isWhitelistedAddress(
  address: string,
  whitelist: string[],
): boolean {
  try {
    if (!isAddress(address) || !Array.isArray(whitelist)) {
      return false;
    }

    const checksummed = getAddress(address);
    const checksummedWhitelist = new Set(
      whitelist.filter((a) => isAddress(a)).map((a) => getAddress(a)),
    );

    return checksummedWhitelist.has(checksummed);
  } catch {
    return false;
  }
}
