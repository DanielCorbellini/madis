export interface TimedResult<T> {
  result: T;
  ms: number;
}

export interface MemorySnapshot {
  rssBytes: number;
  heapUsedBytes: number;
}

export interface PeakMemoryTracker {
  sample(): void;
  peak(): MemorySnapshot;
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

/**
 * Returns a snapshot of the current process's memory usage, including RSS and heap used.
 */
export function snapshotMemory(): MemorySnapshot {
  const usage = process.memoryUsage();
  return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
}

/**
 * Tracks the highest RSS/heapUsed seen across sample() calls.
 * The sample() method can be called as often as desired, and the peak()
 * method will return the highest values seen so far.
 * If no snapshot function is provided, it defaults to using the real snapshotMemory().
 */
export function trackPeakMemory(
  snapshot: () => MemorySnapshot = snapshotMemory,
): PeakMemoryTracker {
  let peakRssBytes = 0;
  let peakHeapUsedBytes = 0;

  return {
    sample() {
      const snap = snapshot();
      peakRssBytes = Math.max(peakRssBytes, snap.rssBytes);
      peakHeapUsedBytes = Math.max(peakHeapUsedBytes, snap.heapUsedBytes);
    },
    peak() {
      return { rssBytes: peakRssBytes, heapUsedBytes: peakHeapUsedBytes };
    },
  };
}
