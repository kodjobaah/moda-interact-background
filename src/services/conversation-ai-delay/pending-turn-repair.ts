import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import {
  backgroundRuntimeConfigService,
  type BackgroundRuntimeConfigSnapshot,
} from "../../runtime/background-runtime-config.js";
import { PROCESSING_LEASE_MS, type ConversationTurnJob } from "../conversation-turn-processor.service.js";
import { resolveEligibleAt } from "./eligibility.js";

export const PENDING_TURN_REPAIR_PAGE_SIZE = 100;
export const PENDING_TURN_REPAIR_MAX_PER_PASS = 1_000;

const logger = createLogger({
  serviceName: "moda-messaging-worker",
  environment: resolveDeploymentEnvironmentName(),
});

type RepairDatabase = Pick<PrismaClient, "$queryRawUnsafe">;
type RepairQueue = Pick<Queue<ConversationTurnJob>, "add">;
type RuntimeConfigReader = Pick<{
  current(): BackgroundRuntimeConfigSnapshot;
}, "current">;

type Candidate = {
  id: string;
  inboundVersion: number;
  pendingAiNotBeforeAt: Date;
  pendingTurnStartedAt: Date;
  lastInboundAt: Date;
};

type Cursor = { deadline: Date; id: string };

export type PendingTurnRepairResult = {
  scanned: number;
  requeued: number;
  skipped: number;
  failed: number;
  oldestDueLagMs: number | null;
};

export class PendingTurnRepairService {
  private cursor: Cursor | null = null;

  constructor(
    private readonly database: RepairDatabase,
    private readonly queue: RepairQueue,
    private readonly runtimeConfig: RuntimeConfigReader = backgroundRuntimeConfigService,
    private readonly now: () => Date = () => new Date(),
    private readonly log: Pick<StructuredLogger, "info" | "warn" | "error"> = logger,
  ) {}

  async runPass(): Promise<PendingTurnRepairResult> {
    const result: PendingTurnRepairResult = {
      scanned: 0,
      requeued: 0,
      skipped: 0,
      failed: 0,
      oldestDueLagMs: null,
    };
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new TypeError("Pending turn repair clock must return a valid Date");
    const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
    const config = this.runtimeConfig.current();

    try {
      while (result.scanned < PENDING_TURN_REPAIR_MAX_PER_PASS) {
        const remaining = PENDING_TURN_REPAIR_MAX_PER_PASS - result.scanned;
        const page = await this.readPage(staleBefore, Math.min(PENDING_TURN_REPAIR_PAGE_SIZE, remaining));
        if (page.length === 0) {
          if (this.cursor) this.cursor = null;
          break;
        }

        for (const candidate of page) {
          result.scanned++;
          const eligibleAt = resolveEligibleAt({
            pendingAiNotBeforeAt: candidate.pendingAiNotBeforeAt,
            lastInboundAt: candidate.lastInboundAt,
            pendingTurnStartedAt: candidate.pendingTurnStartedAt,
            quietMs: config.conversationQuietWindowMs,
            maxMs: config.conversationMaxSettleWindowMs,
          });
          const delay = Math.max(0, eligibleAt - now.getTime());
          if (!Number.isFinite(delay)) {
            result.skipped++;
            this.cursor = { deadline: candidate.pendingAiNotBeforeAt, id: candidate.id };
            this.log.warn("whatsapp.turn.repair.candidate_skipped", {
              conversationId: candidate.id,
              observedVersion: candidate.inboundVersion,
              reason: "invalid-eligible-deadline",
            });
            continue;
          }

          const jobId = `conversation-turn__${candidate.id}__${candidate.inboundVersion}`;
          try {
            await this.queue.add("process-conversation-turn", {
              conversationId: candidate.id,
              observedVersion: candidate.inboundVersion,
            }, { jobId, delay, removeOnComplete: true });
          } catch (error) {
            result.failed++;
            this.log.error("whatsapp.turn.repair.enqueue_failed", {
              conversationId: candidate.id,
              observedVersion: candidate.inboundVersion,
              jobId,
              errorMessage: error instanceof Error ? error.message : String(error),
              error,
            });
            throw error;
          }

          result.requeued++;
          if (eligibleAt <= now.getTime()) {
            result.oldestDueLagMs = Math.max(
              result.oldestDueLagMs ?? 0,
              now.getTime() - eligibleAt,
            );
          }
          this.cursor = { deadline: candidate.pendingAiNotBeforeAt, id: candidate.id };
        }

        if (page.length < Math.min(PENDING_TURN_REPAIR_PAGE_SIZE, remaining)) {
          this.cursor = null;
          break;
        }
      }
      return result;
    } catch (error) {
      if (result.failed === 0) result.failed++;
      throw error;
    } finally {
      this.log.info("whatsapp.turn.repair.pass_completed", result);
    }
  }

  private async readPage(staleBefore: Date, limit: number): Promise<Candidate[]> {
    const cursor = this.cursor;
    return this.database.$queryRawUnsafe<Candidate[]>(`
      SELECT "id", "inboundVersion", "pendingAiNotBeforeAt",
        "pendingTurnStartedAt", "lastInboundAt"
      FROM "whatsapp"."Conversation"
      WHERE "controlMode"='AI'
        AND "pendingAiNotBeforeAt" IS NOT NULL
        AND "pendingTurnStartedAt" IS NOT NULL
        AND "lastInboundAt" IS NOT NULL
        AND "inboundVersion" > "lastProcessedVersion"
        AND "pendingAiControlRevision" = "controlRevision"
        AND ("processingInboundVersion" IS NULL OR "processingStartedAt" IS NULL OR "processingStartedAt" < $3)
        AND ($1::timestamptz IS NULL OR
          ("pendingAiNotBeforeAt", "id") > ($1::timestamptz, $2::text))
      ORDER BY "pendingAiNotBeforeAt", "id"
      LIMIT $4`,
    cursor?.deadline ?? null,
    cursor?.id ?? null,
    staleBefore,
    limit);
  }
}