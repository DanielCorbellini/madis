import { resolveContractAddress } from "contracts-shared";
import "dotenv/config";
import {
  DEFAULT_MAX_BATCH_SIZE,
  integerEnv,
  requiredEnv,
} from "service-runtime";

export type AuditMode = "full" | "sampling";

export interface MonitorConfig {
  databaseUrl: string;
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  cronSchedule: string;
  rpcRetries: number;
  submittedStaleMs: number;
  rootRebuildMaxSize: number;
  auditMode: AuditMode;
  sampleSize: number;
  spotChecks: number;
  sampleSeed: string | undefined;
  escalateOnAnomaly: boolean;
  shutdownGraceMs: number;
  logLevel: string;
}

function auditModeEnv(env: NodeJS.ProcessEnv): AuditMode {
  const raw = env.MONITOR_AUDIT_MODE;

  if (raw === undefined || raw === "") {
    return "full";
  }

  if (raw !== "full" && raw !== "sampling") {
    throw new Error(
      `MONITOR_AUDIT_MODE must be "full" or "sampling", received: ${raw}`,
    );
  }

  return raw;
}

function booleanEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  if (raw !== "true" && raw !== "false") {
    throw new Error(`${key} must be "true" or "false", received: ${raw}`);
  }

  return raw === "true";
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
    // Largest batch whose root is rebuilt in memory. `anchor-service` never
    // builds a batch bigger than ANCHOR_MAX_BATCH_SIZE (and needs at least as
    // much memory to build it), so that cap is safe here too; with no cap set,
    // fall back to a bounded default.
    rootRebuildMaxSize: integerEnv(
      env,
      "ANCHOR_MAX_BATCH_SIZE",
      DEFAULT_MAX_BATCH_SIZE,
      { min: 1 },
    ),
    auditMode: auditModeEnv(env),
    sampleSize: integerEnv(env, "MONITOR_SAMPLE_SIZE", 10, { min: 1 }),
    spotChecks: integerEnv(env, "MONITOR_SPOT_CHECKS", 1, { min: 0 }),
    sampleSeed: env.MONITOR_SAMPLE_SEED || undefined,
    escalateOnAnomaly: booleanEnv(env, "MONITOR_ESCALATE_ON_ANOMALY", true),
    shutdownGraceMs: integerEnv(env, "SHUTDOWN_GRACE_MS", 30_000, { min: 0 }),
    logLevel: env.LOG_LEVEL || "info",
  };
}
