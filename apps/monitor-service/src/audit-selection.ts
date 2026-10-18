import type { RandomInt } from "./random-source.ts";

export interface SelectInput {
  /** `classification.auditable`, or `null` when the chain listing failed. */
  chainIds: number[] | null;
  confirmedIds: number[];
  /** This cycle is an escalated full rescan: sync only (§5.5). */
  escalated: boolean;
}

export interface CycleSelection {
  sliceIds: number[]; // from `order`, at most k
  newIds: number[]; // first sightings audited this cycle (§5.3)
  spotIds: number[]; // at most j (§5.4)
  suspectIds: number[]; // confirmed ids to confirm with getBatchInfo (§5.1/§5.7)
  pass: number; // 0 until the first shuffle
  passPosition: number; // cursor after this cycle's take
  passLength: number; // order.length
}

export interface AuditSelector {
  select(input: SelectInput): CycleSelection;
  /**
   * Puts slice ids whose audit failed without a verdict back into the unvisited
   * part, at most once per pass (§5.3.1). Returns the ids refused a second time.
   */
  requeue(batchIds: number[]): number[];
}

export function createAuditSelector(options: {
  sampleSize: number;
  spotChecks: number;
  randomInt: RandomInt;
}): AuditSelector {
  const { sampleSize, spotChecks, randomInt } = options;

  let order: number[] = [];
  let known = new Set<number>();
  let cursor = 0;
  let pass = 0;
  let requeuedThisPass = new Set<number>();

  // In-place Fisher-Yates; randomInt is never called with 0.
  const shuffle = (ids: number[]): void => {
    for (let i = ids.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
  };

  // Uniform position in the unvisited part, `order.length` included (append).
  const insertUnvisited = (id: number): void => {
    order.splice(cursor + randomInt(order.length - cursor + 1), 0, id);
    known.add(id);
  };

  const result = (
    partial: Pick<
      CycleSelection,
      "sliceIds" | "newIds" | "spotIds" | "suspectIds"
    >,
  ): CycleSelection => ({
    ...partial,
    pass,
    passPosition: cursor,
    passLength: order.length,
  });

  return {
    select({ chainIds, confirmedIds, escalated }) {
      if (pass === 0) {
        if (chainIds === null) {
          return result({
            sliceIds: [],
            newIds: [],
            spotIds: [],
            suspectIds: [...confirmedIds],
          });
        }
        order = [...new Set(chainIds)];
        shuffle(order);
        known = new Set(order);
        cursor = 0;
        pass = 1;
      }

      const chainSet = chainIds === null ? null : new Set(chainIds);
      const arrivals: number[] = [];

      if (chainSet !== null) {
        const kept: number[] = [];
        let removedBeforeCursor = 0;
        order.forEach((id, index) => {
          if (chainSet.has(id)) {
            kept.push(id);
          } else {
            known.delete(id);
            if (index < cursor) removedBeforeCursor++;
          }
        });
        order = kept;
        cursor -= removedBeforeCursor;
        for (const id of chainSet) {
          if (!known.has(id)) arrivals.push(id);
        }
      }

      if (escalated) {
        for (const id of arrivals) insertUnvisited(id);
        return result({
          sliceIds: [],
          newIds: [],
          spotIds: [],
          suspectIds: [],
        });
      }

      if (cursor === order.length && order.length > 0) {
        shuffle(order);
        cursor = 0;
        pass++;
        requeuedThisPass = new Set();
      }

      const sliceIds = order.slice(cursor, cursor + sampleSize);
      cursor += sliceIds.length;

      for (const id of arrivals) insertUnvisited(id);
      const newIds = arrivals;

      // Partial Fisher-Yates over the remaining candidates, no redraw loop.
      const taken = new Set([...sliceIds, ...newIds]);
      const candidates = (chainIds ?? [...known]).filter(
        (id) => !taken.has(id),
      );
      const spotCount = Math.min(spotChecks, candidates.length);
      for (let i = 0; i < spotCount; i++) {
        const j = i + randomInt(candidates.length - i);
        [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
      }
      const spotIds = candidates.slice(0, spotCount);

      const suspectIds = confirmedIds.filter((id) =>
        chainSet !== null ? !chainSet.has(id) : !known.has(id),
      );

      return result({ sliceIds, newIds, spotIds, suspectIds });
    },

    requeue(batchIds) {
      const refused: number[] = [];
      for (const id of batchIds) {
        if (!known.has(id)) continue;
        // A second failure in the same pass consumes the slot, so the pass still ends.
        if (requeuedThisPass.has(id)) {
          refused.push(id);
          continue;
        }
        requeuedThisPass.add(id);
        const index = order.indexOf(id);
        order.splice(index, 1);
        if (index < cursor) cursor--;
        order.splice(cursor + randomInt(order.length - cursor + 1), 0, id);
      }
      return refused;
    },
  };
}
