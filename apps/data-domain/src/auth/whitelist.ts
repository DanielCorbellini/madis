import { isWhitelistedAddress } from "crypto-utils";

export type WhitelistChecker = (clientAddress: string) => Promise<boolean>;

export function createEnvWhitelistChecker(addresses: string[]): WhitelistChecker {
  return async (clientAddress: string) => isWhitelistedAddress(clientAddress, addresses);
}
