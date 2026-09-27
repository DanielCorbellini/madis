import { resolveContractAddress } from "contracts-shared";
import "dotenv/config";
import { integerEnv, requiredEnv } from "service-runtime";

export interface MonitorConfig {
  databaseUrl: string;
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  cronSchedule: string;
  rpcRetries: number;
  submittedStaleMs: number;
  shutdownGraceMs: number;
  logLevel: string;
}

/**
 * `monitor-service` never signs or sends a transaction, so a private key
 * in its environment is a configuration error, not a harmless unused
 * variable, fail loudly rather than silently ignore it.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): MonitorConfig {
  if (env.ANCHOR_PRIVATE_KEY) {
    throw new Error(
      "ANCHOR_PRIVATE_KEY must not be set for monitor-service — it never signs or sends transactions",
    );
  }

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

  return {
    databaseUrl,
    rpcUrl,
    chainId,
    contractAddress,
    cronSchedule: env.MONITOR_CRON_SCHEDULE || "*/5 * * * *",
    rpcRetries: integerEnv(env, "MONITOR_RPC_RETRIES", 4, { min: 0 }),
    submittedStaleMs: integerEnv(
      env,
      "MONITOR_SUBMITTED_STALE_MS",
      86_400_000,
      {
        min: 0,
      },
    ),
    shutdownGraceMs: integerEnv(env, "SHUTDOWN_GRACE_MS", 30_000, { min: 0 }),
    logLevel: env.LOG_LEVEL || "info",
  };
}
