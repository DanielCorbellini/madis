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
