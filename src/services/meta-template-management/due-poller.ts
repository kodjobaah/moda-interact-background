import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { safeMetaError } from "./contracts.js";
import { metaTemplateManagementService } from "./service.js";

const logger = createLogger({
  serviceName: "moda-messaging-worker", environment: resolveDeploymentEnvironmentName(),
});

export interface MetaDuePollerOptions {
  processDue: (limit: number) => Promise<unknown>;
  log: Pick<StructuredLogger, "info" | "error">;
  jitterMs: number;
  delay?: (run: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Production lifecycle: at most one Meta reconciliation cycle per process.
 * DB CAS (not this local timer) coordinates independent worker replicas.
 * A cycle failure is logged and the next bounded cycle remains scheduled. */
export function startMetaTemplateDuePoller({
  processDue, log, jitterMs,
  delay = setTimeout, cancel = clearTimeout,
}: MetaDuePollerOptions): () => Promise<void> {
  if (!Number.isFinite(jitterMs) || jitterMs < 0 || jitterMs > 10_000) {
    throw new RangeError("BG003 jitter must be between zero and ten seconds");
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running: Promise<void> | null = null;
  const schedule = (ms: number) => {
    if (!stopped) timer = delay(() => { timer = null; void cycle(); }, ms);
  };
  const cycle = async () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        const result = await processDue(25);
        log.info("meta.template.due.cycle_completed", { result: typeof result === "object" ? "processed" : "completed" });
      } catch (error) {
        log.error("meta.template.due.cycle_failed", {
          ...safeMetaError(error),
          errorMessage: error instanceof Error ? error.message : String(error),
          error,
        });
      }
    })();
    try { await running; }
    finally {
      running = null;
      schedule(60_000);
    }
  };
  schedule(jitterMs);
  return async () => {
    stopped = true;
    if (timer !== null) { cancel(timer); timer = null; }
    if (running) await running;
  };
}

export function startProductionMetaTemplateDuePoller(): () => Promise<void> {
  return startMetaTemplateDuePoller({
    processDue: (limit) => metaTemplateManagementService.processDueRegistrations(limit),
    log: logger,
    jitterMs: Math.floor(Math.random() * 10_001),
  });
}
