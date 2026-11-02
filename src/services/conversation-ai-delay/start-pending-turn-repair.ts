import type { Queue } from "bullmq";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import prisma from "../../lib/db.js";
import { backgroundRuntimeConfigService } from "../../runtime/background-runtime-config.js";
import type { ConversationTurnJob } from "../conversation-turn-processor.service.js";
import { PendingTurnRepairService } from "./pending-turn-repair.js";

export const PENDING_TURN_REPAIR_INTERVAL_MS = 30_000;

const logger = createLogger({
  serviceName: "moda-messaging-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export type PendingTurnRepairPollerOptions = {
  runPass: () => Promise<unknown>;
  log: Pick<StructuredLogger, "error">;
  delay?: (run: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
};

export function startPendingTurnRepairPoller({
  runPass,
  log,
  delay = setTimeout,
  cancel = clearTimeout,
}: PendingTurnRepairPollerOptions): () => Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const schedule = () => {
    if (!stopped) {
      timer = delay(() => {
        timer = null;
        void cycle();
      }, PENDING_TURN_REPAIR_INTERVAL_MS);
    }
  };

  const cycle = async () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        await runPass();
      } catch (error) {
        log.error("whatsapp.turn.repair.pass_failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          error,
        });
      }
    })();
    try {
      await running;
    } finally {
      running = null;
      schedule();
    }
  };

  schedule();
  return async () => {
    stopped = true;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    if (running) await running;
  };
}

export function startProductionPendingTurnRepair(
  queue: Pick<Queue<ConversationTurnJob>, "add" | "getJob">,
): () => Promise<void> {
  const service = new PendingTurnRepairService(
    prisma,
    queue,
    backgroundRuntimeConfigService,
  );
  return startPendingTurnRepairPoller({ runPass: () => service.runPass(), log: logger });
}