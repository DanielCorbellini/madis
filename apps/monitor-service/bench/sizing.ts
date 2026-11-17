/** 1 hour of 1-minute cycles: the worst case the thesis guarantees (spec §3). */
export const MAIN_POLICY_CYCLES = 60;

export interface Policy {
  name: string;
  windowMinutes: number;
  cronMinutes: number;
}

export const POLICIES: Policy[] = [
  { name: "1h@1min", windowMinutes: 60, cronMinutes: 1 },
  { name: "1h@5min", windowMinutes: 60, cronMinutes: 5 },
  { name: "1d@5min", windowMinutes: 1440, cronMinutes: 5 },
];

/** Longest pass L whose worst case 2L − 1 fits in the cycle budget. */
export function maxPassLength(cyclesBudget: number): number {
  return Math.floor((cyclesBudget + 1) / 2);
}

/** Smallest k whose pass ⌈m/k⌉ fits the budget's longest pass. */
export function requiredSampleSize(m: number, cyclesBudget: number): number {
  return Math.ceil(m / maxPassLength(cyclesBudget));
}

export function sizingRows(ms: number[]) {
  return ms.flatMap((m) =>
    POLICIES.map((policy) => {
      const cyclesBudget = policy.windowMinutes / policy.cronMinutes;
      const kRequired = requiredSampleSize(m, cyclesBudget);
      const batchesPerCycle = kRequired + 1; // j = 1

      return {
        m,
        policy: policy.name,
        cyclesBudget,
        passLength: maxPassLength(cyclesBudget),
        kRequired,
        batchesPerCycle,
        percentOfM: Math.round((batchesPerCycle / m) * 1000) / 10,
      };
    }),
  );
}
