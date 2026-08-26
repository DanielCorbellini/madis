import { buildApp } from "./app.ts";
import { createEnvWhitelistChecker } from "./auth/whitelist.ts";
import { loadConfig } from "./config.ts";
import { checkDatabaseConnection, createDbPool } from "./db.ts";
import { createPostgresRecordRepository } from "./domain/records/record-repository.ts";

async function main() {
  const config = loadConfig();
  const pool = createDbPool(config.databaseUrl);
  await checkDatabaseConnection(pool);

  const repository = createPostgresRecordRepository(pool);
  const isClientAuthorized = createEnvWhitelistChecker(
    config.whitelistedAddresses,
  );

  const app = buildApp({ repository, isClientAuthorized });

  app.get("/health", async () => {
    await checkDatabaseConnection(pool);
    return { status: "ok" };
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
