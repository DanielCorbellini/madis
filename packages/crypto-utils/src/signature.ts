import { getAddress, isAddress, verifyMessage } from "ethers";
import { canonicalize } from "./canonicalizer.ts";
import type { RecordPayload } from "./types.ts";

/**
 * Recovers the Ethereum address that signed the canonical representation of data.
 */
export function recoverSignerAddress(
  data: Record<string, unknown>,
  signature: string,
): string {
  const canonicalData = canonicalize(data);
  return verifyMessage(canonicalData, signature);
}

/**
 * Verifies whether the signature matches the clientAddress in the payload.
 * Checks if the address that signed the payload does not match the clientAddress, or if any of the required fields are missing, it returns false.
 */
export function verifyClientSignature(payload: RecordPayload): boolean {
  try {
    if (!payload.clientAddress || !payload.signature || !payload.data) {
      return false;
    }

    const recoveredAddress = recoverSignerAddress(
      payload.data,
      payload.signature,
    );

    return getAddress(recoveredAddress) === getAddress(payload.clientAddress);
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
