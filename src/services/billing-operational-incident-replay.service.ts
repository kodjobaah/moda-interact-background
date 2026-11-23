import { ShopPlatform, SubscriptionProjectionStatus, type PrismaClient, type Prisma } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import prisma from "../lib/db.js";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import {
  billingIncidentProjectionSelect,
  billingOperationalIncidentSink,
  nonActionableBillingErrorCodes,
  type BillingIncidentSink,
} from "./billing-operational-incident.service.js";

const REPLAY_BATCH_LIMIT = 50;

type IncidentReplayDatabase = Pick<PrismaClient, "subscription">;

/**
 * Bounded, periodic second chance for committed billing failures whose
 * incident publication failed. Reuses the billing worker's existing cadence;
 * no queue, retry state, or separate persistence mechanism is introduced.
 */
export class BillingOperationalIncidentReplayService {
  private lastSeenSubscriptionId: string | null = null;

  constructor(
    private readonly database: IncidentReplayDatabase,
    private readonly sink: BillingIncidentSink,
    private readonly logger: StructuredLogger,
  ) {}

  async replayOnce(): Promise<number> {
    const actionable = {
      shop: { is: { platform: ShopPlatform.SHOPIFY } },
      OR: [
        { status: SubscriptionProjectionStatus.UNMAPPED },
        { lastSyncErrorCode: { not: null, notIn: [...nonActionableBillingErrorCodes] } },
      ],
    } satisfies Prisma.SubscriptionWhereInput;
    const findPage = (afterId: string | null) => this.database.subscription.findMany({
      where: { ...actionable, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: "asc" },
      take: REPLAY_BATCH_LIMIT,
      select: { ...billingIncidentProjectionSelect, shopId: true },
    });

    let rows = await findPage(this.lastSeenSubscriptionId);
    if (rows.length === 0 && this.lastSeenSubscriptionId !== null) {
      // Wrap after the final eligible record; every still-open failure is
      // eventually revisited, including ones with nextReconcileAt = null.
      this.lastSeenSubscriptionId = null;
      rows = await findPage(null);
    }
    this.lastSeenSubscriptionId = rows.at(-1)?.id ?? null;

    for (const row of rows) {
      try {
        await this.sink.report(row.shopId, row);
      } catch (error) {
        // A reporter defect must not starve later incidents or stop billing.
        this.logger.error("billing.operational_incident.replay_failed", {
          shopId: row.shopId,
          subscriptionId: row.id,
          errorMessage: error instanceof Error ? error.message : String(error),
          error,
        });
      }
    }
    return rows.length;
  }
}

export const billingOperationalIncidentReplayService = new BillingOperationalIncidentReplayService(
  prisma,
  billingOperationalIncidentSink,
  createLogger({ serviceName: "moda-billing-worker", environment: resolveDeploymentEnvironmentName() }),
);
