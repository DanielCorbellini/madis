import "dotenv/config";
import { merkleAnchorRegistryAddress } from "contracts-shared/deployments";
import { isAddress } from "ethers";

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
  /** `null` means "no cap" — anchor every pending record in a single batch. */
  maxBatchSize: number | null;
  shutdownGraceMs: number;
  logLevel: string;
}

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Resolves the `MerkleAnchorRegistry` address for the target chain: the
 * `CONTRACT_ADDRESS` env override wins (useful for local forks), otherwise the
 * committed deployment registered in `contracts-shared` for that chain id.
 */
export function resolveContractAddress(
  chainId: number,
  override: string | undefined,
  lookup: (chainId: number) => string | undefined = merkleAnchorRegistryAddress,
): string {
  const address = override?.trim() || lookup(chainId);

  if (!address) {
    throw new Error(
      `No contract address for chain ${chainId}: set CONTRACT_ADDRESS or register a deployment in contracts-shared`,
    );
  }

  if (!isAddress(address)) {
    throw new Error(`Contract address is not a valid address: ${address}`);
  }
  return address;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (!value) {
    throw new Error(`${key} environment variable is required`);
  }

  return value;
}

function integer(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  { min }: { min: number },
): number {
  const raw = env[key];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${key} must be an integer >= ${min}, received: ${raw}`);
  }

  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AnchorConfig {
  const databaseUrl = required(env, "DATABASE_URL");
  const rpcUrl = required(env, "RPC_URL");
  const chainIdRaw = required(env, "ANCHOR_CHAIN_ID");
  const chainId = Number(chainIdRaw);

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(
      `ANCHOR_CHAIN_ID must be a positive integer, received: ${chainIdRaw}`,
    );
  }

  const contractAddress = resolveContractAddress(chainId, env.CONTRACT_ADDRESS);

  const anchorPrivateKey = required(env, "ANCHOR_PRIVATE_KEY");

  if (!PRIVATE_KEY_PATTERN.test(anchorPrivateKey)) {
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

  const maxBatchSizeRaw = env.ANCHOR_MAX_BATCH_SIZE;
  let maxBatchSize: number | null = null;

  if (maxBatchSizeRaw !== undefined && maxBatchSizeRaw !== "") {
    maxBatchSize = Number(maxBatchSizeRaw);

    if (!Number.isInteger(maxBatchSize) || maxBatchSize <= 0) {
      throw new Error(
        `ANCHOR_MAX_BATCH_SIZE must be a positive integer, received: ${maxBatchSizeRaw}`,
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
    confirmations: integer(env, "ANCHOR_CONFIRMATIONS", 3, { min: 0 }),
    confirmationTimeoutMs: integer(
      env,
      "ANCHOR_CONFIRMATION_TIMEOUT_MS",
      300_000,
      { min: 0 },
    ),
    maxFeeGwei: integer(env, "ANCHOR_MAX_FEE_GWEI", 100, { min: 1 }),
    txRetries: integer(env, "ANCHOR_TX_RETRIES", 4, { min: 0 }),
    retryAlertThreshold: integer(env, "ANCHOR_RETRY_ALERT_THRESHOLD", 5, {
      min: 1,
    }),
    maxBatchSize,
    shutdownGraceMs: integer(env, "SHUTDOWN_GRACE_MS", 600_000, { min: 0 }),
    logLevel: env.LOG_LEVEL || "info",
  };
}
