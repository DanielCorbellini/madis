export interface TimedResult<T> {
  result: T;
  ms: number;
}

/**
 * Measures how long an async function takes. Propagates whatever `fn`
 * throws or rejects with, unchanged — timing a failure is still timing.
 */
export async function timed<T>(fn: () => Promise<T>): Promise<TimedResult<T>> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

export interface MemorySnapshot {
  rssBytes: number;
  heapUsedBytes: number;
}

export function snapshotMemory(): MemorySnapshot {
  const usage = process.memoryUsage();
  return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
}
