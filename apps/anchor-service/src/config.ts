import { resolveContractAddress } from "contracts-shared";
import "dotenv/config";
import { isAddress, isHexString } from "ethers";
import {
  DEFAULT_MAX_BATCH_SIZE,
  integerEnv,
  requiredEnv,
} from "service-runtime";

export interface AnchorConfig {
  databaseUrl: string;
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  anchorPrivateKey: string;
  whitelistedAddresses: string[];
  cronSchedule: string;
  confirmations: number;
  confirmationTimeoutMs: number;
  maxFeeGwei: number;
  txRetries: number;
  retryAlertThreshold: number;
  maxBatchSize: number;
  shutdownGraceMs: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AnchorConfig {
  const databaseUrl = requiredEnv(env, "DATABASE_URL");
  const rpcUrl = requiredEnv(env, "RPC_URL");
  const chainIdRaw = requiredEnv(env, "ANCHOR_CHAIN_ID");
  const chainId = Number(chainIdRaw);

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(
      `ANCHOR_CHAIN_ID must be a positive integer, received: ${chainIdRaw}`,
    );
  }

  const contractAddress = resolveContractAddress(chainId, env.CONTRACT_ADDRESS);
  const anchorPrivateKey = requiredEnv(env, "ANCHOR_PRIVATE_KEY");

  if (!isHexString(anchorPrivateKey, 32)) {
    throw new Error(
      "ANCHOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string",
    );
  }

  const whitelistedAddresses = (env.WHITELIST_ADDRESSES ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address.length > 0);

  for (const address of whitelistedAddresses) {
    if (!isAddress(address)) {
      throw new Error(
        `WHITELIST_ADDRESSES contains an invalid address: ${address}`,
      );
    }
  }

  return {
    databaseUrl,
    rpcUrl,
    chainId,
    contractAddress,
    anchorPrivateKey,
    whitelistedAddresses,
    cronSchedule: env.ANCHOR_CRON_SCHEDULE || "0 */3 * * *",
    confirmations: integerEnv(env, "ANCHOR_CONFIRMATIONS", 3, { min: 0 }),
    confirmationTimeoutMs: integerEnv(
      env,
      "ANCHOR_CONFIRMATION_TIMEOUT_MS",
      300_000,
      { min: 0 },
    ),
    maxFeeGwei: integerEnv(env, "ANCHOR_MAX_FEE_GWEI", 100, { min: 1 }),
    txRetries: integerEnv(env, "ANCHOR_TX_RETRIES", 4, { min: 0 }),
    retryAlertThreshold: integerEnv(env, "ANCHOR_RETRY_ALERT_THRESHOLD", 5, {
      min: 1,
    }),
    maxBatchSize: integerEnv(
      env,
      "ANCHOR_MAX_BATCH_SIZE",
      DEFAULT_MAX_BATCH_SIZE,
      { min: 1 },
    ),
    shutdownGraceMs: integerEnv(env, "SHUTDOWN_GRACE_MS", 600_000, { min: 0 }),
    logLevel: env.LOG_LEVEL || "info",
  };
}
