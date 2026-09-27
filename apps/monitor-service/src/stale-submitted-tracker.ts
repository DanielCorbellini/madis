export interface StaleSubmittedTracker {
  /**
   * Called once per cycle for every batch id currently `'submitted'` in
   * Postgres. Returns whether this batch id has now been observed,
   * continuously, for at least `staleAfterMs` — measured entirely by
   * this process's own clock, never by anything read from Postgres.
   * `batches.created_at` is itself an ordinary, attacker-writable column
   * under this project's threat model, so it can't be trusted as a
   * staleness signal, this tracker exists specifically to
   * avoid depending on it.
   */
  observe(batchId: number): boolean;
  /**
   * Called once per cycle with every batch id currently `'submitted'`.
   * Drops tracking for any previously-seen batch id that isn't in this
   * list anymore (it resolved, one way or another), so the map never
   * grows to include batches monitor-service no longer considers
   * in-flight.
   */
  pruneExcept(currentBatchIds: number[]): void;
}

/**
 * Creates a tracker with no persisted state, everything lives in the
 * returned closure's `Map` for as long as the process does. A restart
 * clears it, giving every currently -`'submitted'` batch one fresh grace
 * period before staleness is judged again.
 */
export function createStaleSubmittedTracker(
  staleAfterMs: number,
  now: () => number = Date.now,
): StaleSubmittedTracker {
  const firstSeenAt = new Map<number, number>();

  return {
    observe(batchId) {
      const seenAt = firstSeenAt.get(batchId);

      if (seenAt === undefined) {
        firstSeenAt.set(batchId, now());
        return false;
      }

      return now() - seenAt >= staleAfterMs;
    },
    pruneExcept(currentBatchIds) {
      const keep = new Set(currentBatchIds);
      for (const batchId of firstSeenAt.keys()) {
        if (!keep.has(batchId)) {
          firstSeenAt.delete(batchId);
        }
      }
    },
  };
}
