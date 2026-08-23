import Fastify from "fastify";
import { loadConfig } from "./config.ts";
import { checkDatabaseConnection, createDbPool } from "./db.ts";

async function main() {
  const config = loadConfig();
  const pool = createDbPool(config.databaseUrl);
  await checkDatabaseConnection(pool);

  const app = Fastify({ logger: true });

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
