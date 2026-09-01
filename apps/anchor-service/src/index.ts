import {
  assertContractDeployed,
  assertNetworkMatches,
  assertWalletIsOwner,
  createChainClient,
} from "./chain.ts";
import { loadConfig } from "./config.ts";
import { checkDatabaseConnection, createDbPool } from "./db.ts";
import { createLogger } from "./logger.ts";

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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
