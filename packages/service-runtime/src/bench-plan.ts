/** Sizes above this run fewer repetitions: each one takes minutes, and spreads are small. */
export const LARGE_SIZE_THRESHOLD = 100_000;

const SERIES = [1, 2, 5];

/** The 1-2-5 series between `from` (a power of ten) and `to`, inclusive: evenly spaced on a log axis. */
export function oneTwoFive(from: number, to: number): number[] {
  const values: number[] = [];
  for (let decade = from; decade <= to; decade *= 10) {
    for (const step of SERIES) {
      if (decade * step <= to) values.push(decade * step);
    }
  }
  return values;
}

/** Records per batch: the 1-2-5 series from 1,000 up to the batch limit. */
export function defaultBenchSizes(maxBatchSize: number): number[] {
  return oneTwoFive(1000, maxBatchSize);
}

/**
 * `--sizes`, bounded by ANCHOR_MAX_BATCH_SIZE: above it the configured system
 * never anchors or audits a batch, so a single-batch measurement isn't faithful.
 */
export function parseBenchSizes(raw: string | undefined, maxBatchSize: number): number[] {
  if (raw === undefined) return defaultBenchSizes(maxBatchSize);

  const sizes = raw.split(",").map((part) => Number(part.trim()));
  if (sizes.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`--sizes must be a comma-separated list of positive integers, received: ${raw}`);
  }

  const tooBig = sizes.filter((n) => n > maxBatchSize);
  if (tooBig.length > 0) {
    throw new Error(
      `size ${tooBig.join(", ")} is above the batch limit ${maxBatchSize}: the system never anchors or audits a batch that large. Set ANCHOR_MAX_BATCH_SIZE to at least ${Math.max(...tooBig)} to measure it as one batch.`,
    );
  }
  return sizes;
}

export function parseRepeats(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer, received: ${raw}`);
  }
  return value;
}

export function repeatsFor(n: number, repeats: number, repeatsLarge: number): number {
  return n > LARGE_SIZE_THRESHOLD ? repeatsLarge : repeats;
}
