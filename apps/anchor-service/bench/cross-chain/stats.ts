/** Linear interpolation between the closest ranks (numpy's default); `q` in [0, 1]. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) {
    throw new Error("percentile of an empty array");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * q;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export interface Summary {
  n: number;
  mean: number;
  stdev: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

/** Sample statistics; the standard deviation uses n − 1 and is 0 for a single value. */
export function summarize(values: number[]): Summary {
  const n = values.length;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance =
    n > 1 ? values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1) : 0;
  return {
    n,
    mean,
    stdev: Math.sqrt(variance),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}
