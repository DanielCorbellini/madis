import type { CrossChainNetwork } from "./config.ts";
import { emptyRow } from "./measure.ts";
import type { CrossChainRow, NetworkKind, Tick } from "./types.ts";

// Fast-including networks go first and each send waits a few seconds after
// the previous one, so their fast inclusion polling never overlaps and the
// three stay under the RPC provider's per-second limit.
const SEND_ORDER: NetworkKind[] = ["arbitrum", "polygon", "ethereum"];
export const STAGGER_MS = 5_000;

export type AnchorFn = (
  net: CrossChainNetwork,
  tick: Tick,
  onIncluded: () => void,
) => Promise<CrossChainRow>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs one tick on every network. A network still waiting for its previous
 * anchoring's inclusion is recorded as `skipped-busy` (sending would collide
 * on the nonce); a finality wait does not block the next tick. Each row is
 * handed to `onRow` as soon as it settles; resolves when all have.
 */
export async function runTick(
  nets: CrossChainNetwork[],
  tick: Tick,
  runId: string,
  busy: Map<string, boolean>,
  anchor: AnchorFn,
  onRow: (row: CrossChainRow) => void,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  const ordered = [...nets].sort((a, b) => SEND_ORDER.indexOf(a.kind) - SEND_ORDER.indexOf(b.kind));
  const pending: Promise<void>[] = [];

  for (const [i, net] of ordered.entries()) {
    if (i > 0) await wait(STAGGER_MS);
    if (busy.get(net.name)) {
      onRow(emptyRow(net, tick, runId, "skipped-busy"));
      continue;
    }
    busy.set(net.name, true);
    const release = () => busy.set(net.name, false);
    pending.push(
      anchor(net, tick, release)
        .then(onRow)
        .finally(release),
    );
  }
  await Promise.all(pending);
}
