import { Cron } from "croner";
import { pathToFileURL } from "node:url";
import {
  assertContractDeployed,
  assertNetworkMatches,
  checkDatabaseConnection,
  createDbPool,
  createLogger,
  shutdownGracefully,
  type Logger,
} from "service-runtime";
import { createAuditDeps } from "./audit.ts";
import { createReadOnlyChainClient, createRetryingContract } from "./chain.ts";
import { loadConfig, type MonitorConfig } from "./config.ts";
import { createCycleDeps, runMonitorCycle, type CycleDeps } from "./cycle.ts";

export async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info(
    { chainId: config.chainId, contract: config.contractAddress },
    "monitor-service starting",
  );

  const pool = createDbPool(config.databaseUrl);
  const chain = createReadOnlyChainClient(config);

  try {
    await checkDatabaseConnection(pool);
    logger.info("database connection ok");

    await assertNetworkMatches(chain.provider, config.chainId);
    await assertContractDeployed(chain.provider, config.contractAddress);

    logger.info("chain connection ok");
  } catch (error) {
    await pool.end();
    chain.provider.destroy();
    throw error;
  }

  const retryingContract = createRetryingContract(chain.contract, {
    retries: config.rpcRetries,
  });
  const auditDeps = createAuditDeps(retryingContract, pool);
  const deps = createCycleDeps(auditDeps, retryingContract, pool, logger, {
    submittedStaleMs: config.submittedStaleMs,
  });

  let shutdownRequested = false;
  const scheduler = createCycleScheduler(
    deps,
    config,
    logger,
    () => shutdownRequested,
  );

  logger.info({ schedule: config.cronSchedule }, "scheduler started");

  const shutdown = async () => {
    logger.info("shutdown requested");
    await shutdownGracefully({
      cron: scheduler.cron,
      pool,
      provider: chain.provider,
      getCurrentCycle: scheduler.getCurrentCycle,
      requestAbort: () => {
        shutdownRequested = true;
      },
      shutdownGraceMs: config.shutdownGraceMs,
      logger,
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * If this file is run directly (e.g., `node index.js`), execute the main function.
 * If this file is imported as a module, do not execute the main function.
 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export interface CycleScheduler {
  cron: Cron;
  getCycleCount(): number;
  getCurrentCycle(): Promise<void> | null;
}

/**
 * croner's `protect` callback: fires when a *scheduled* tick is skipped
 * because the previous cycle hasn't finished yet.
 */
export function logSkippedOverlap(logger: Logger) {
  return (job: Cron): void => {
    logger.warn(
      { previousCycleStartedAt: job.currentRun() },
      "previous monitor cycle is still running — skipping this scheduled tick",
    );
  };
}

/**
 * Wraps `runMonitorCycle` in a croner schedule.
 */
export function createCycleScheduler(
  deps: CycleDeps,
  config: Pick<MonitorConfig, "cronSchedule">,
  logger: Logger,
  shouldAbort: () => boolean,
): CycleScheduler {
  let cycleCount = 0;
  let currentCycle: Promise<void> | null = null;

  const cron = new Cron(
    config.cronSchedule,
    { protect: logSkippedOverlap(logger) },
    async () => {
      cycleCount++;
      const cycleNumber = cycleCount;

      currentCycle = (async () => {
        try {
          await runMonitorCycle(deps, cycleNumber, logger, shouldAbort);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.error(
            { cycle: cycleNumber, err: message },
            "cycle failed unexpectedly",
          );
        } finally {
          currentCycle = null;
        }
      })();

      await currentCycle;
    },
  );

  return {
    cron,
    getCycleCount: () => cycleCount,
    getCurrentCycle: () => currentCycle,
  };
}
