/**
 * Largest batch (in records) `anchor-service` builds in one go, and — because
 * no batch is ever larger — the largest batch `monitor-service` rebuilds in
 * memory. Both services default to this when `ANCHOR_MAX_BATCH_SIZE` is unset,
 * so they cannot drift apart.
 */
export const DEFAULT_MAX_BATCH_SIZE = 100_000;

export function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (!value) {
    throw new Error(`${key} environment variable is required`);
  }

  return value;
}

export function integerEnv(
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
