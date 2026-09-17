import { Cron } from "croner";
import { pathToFileURL } from "node:url";
import {
  checkDatabaseConnection,
  createDbPool,
  createLogger,
  type Logger,
} from "service-runtime";
import {
  assertContractDeployed,
  assertNetworkMatches,
  assertWalletIsOwner,
  createChainClient,
} from "./chain.ts";
import type { AnchorConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { runCycle, type CycleDeps } from "./cycle.ts";

export async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info(
    { chainId: config.chainId, contract: config.contractAddress },
    "anchor-service starting",
  );

  if (config.whitelistedAddresses.length === 0) {
    logger.warn(
      "WHITELIST_ADDRESSES is empty — every record will fail the whitelist check and be rejected",
    );
  }

  const pool = createDbPool(config.databaseUrl);
  const chain = createChainClient(config);

  try {
    await checkDatabaseConnection(pool);
    logger.info("database connection ok");

    await assertNetworkMatches(chain.provider, config.chainId);
    await assertContractDeployed(chain.provider, config.contractAddress);
    await assertWalletIsOwner(chain.contract, chain.wallet.address);

    logger.info(
      { wallet: chain.wallet.address },
      "chain connection ok — anchor wallet is the contract owner",
    );

    logger.info("startup checks passed; scheduler is not wired yet");
  } finally {
    await pool.end();
    chain.provider.destroy();
  }
}

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
 * Wraps `runCycle` in a croner schedule. `protect: true` is croner's own
 * overlap guard — a tick is skipped entirely if the previous cycle hasn't
 * finished yet, so at most one cycle ever runs at a time. Each cycle's own
 * errors are caught and logged here — one bad cycle must not crash the
 * process; the next scheduled tick simply tries again.
 */
export function createCycleScheduler(
  deps: CycleDeps,
  config: Pick<
    AnchorConfig,
    | "cronSchedule"
    | "whitelistedAddresses"
    | "confirmations"
    | "confirmationTimeoutMs"
  >,
  logger: Logger,
  shouldAbort: () => boolean,
): CycleScheduler {
  let cycleCount = 0;
  let currentCycle: Promise<void> | null = null;

  const cron = new Cron(config.cronSchedule, { protect: true }, async () => {
    cycleCount++;
    const cycleNumber = cycleCount;

    currentCycle = (async () => {
      try {
        await runCycle(
          deps,
          {
            cycleNumber,
            whitelistedAddresses: config.whitelistedAddresses,
            confirmations: config.confirmations,
            confirmationTimeoutMs: config.confirmationTimeoutMs,
          },
          logger,
          shouldAbort,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          { cycle: cycleNumber, err: message },
          "cycle failed unexpectedly",
        );
      } finally {
        currentCycle = null;
      }
    })();

    await currentCycle;
  });

  return {
    cron,
    getCycleCount: () => cycleCount,
    getCurrentCycle: () => currentCycle,
  };
}
