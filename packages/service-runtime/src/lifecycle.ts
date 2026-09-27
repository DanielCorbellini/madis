import type { Cron } from "croner";
import type { Pool } from "pg";
import type { Logger } from "./logger.ts";

export interface ShutdownDeps {
  cron: Pick<Cron, "stop">;
  pool: Pick<Pool, "end">;
  provider: { destroy(): void };
  getCurrentCycle(): Promise<void> | null;
  requestAbort(): void;
  shutdownGraceMs: number;
  logger: Logger;
  exit?: (code: number) => void;
}

/**
 * Stops the scheduler and, if a cycle is in-flight, waits for it — up to
 * `shutdownGraceMs` — before closing the DB pool and destroying the chain
 * provider. `requestAbort()` flips whatever flag the caller's own cycle
 * loop reads to decide whether to continue past the current unit of work,
 * so an in-flight cycle that hasn't reached its next abort checkpoint yet
 * leaves things in a safe, resumable state instead of starting new work
 * after shutdown was already requested. If the grace period elapses first,
 * hard-exits via the injected `exit` (defaulting to the real `process.exit`)
 * rather than waiting indefinitely or risking a graceful close on a
 * genuinely stuck cycle.
 */
export async function shutdownGracefully(deps: ShutdownDeps): Promise<void> {
  const exit = deps.exit ?? process.exit;

  deps.cron.stop();
  deps.requestAbort();

  const currentCycle = deps.getCurrentCycle();
  if (currentCycle) {
    deps.logger.info(
      "waiting for the in-flight cycle to finish before exiting",
    );

    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, deps.shutdownGraceMs);
    });

    await Promise.race([currentCycle, timeout]);

    if (timedOut) {
      deps.logger.error(
        { shutdownGraceMs: deps.shutdownGraceMs },
        "in-flight cycle did not finish within the grace period — hard exit",
      );
      exit(1);
      return;
    }
  }

  await deps.pool.end();
  deps.provider.destroy();
  deps.logger.info("shutdown complete");
}
