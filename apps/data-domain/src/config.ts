import "dotenv/config";

export interface AppConfig {
  port: number;
  databaseUrl: string;
  whitelistedAddresses: string[];
  nodeEnv: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const port = env.PORT ? Number(env.PORT) : 3000;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT environment variable: ${env.PORT}`);
  }

  const whitelistedAddresses = (env.WHITELIST_ADDRESSES ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address.length > 0);

  return {
    port,
    databaseUrl,
    whitelistedAddresses,
    nodeEnv: env.NODE_ENV ?? "development",
  };
}
