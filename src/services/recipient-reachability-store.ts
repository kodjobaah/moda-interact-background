import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../lib/db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type StoreDatabase = Pick<PrismaClient, "$queryRaw" | "platformBillingPolicy">;
export type ReachabilityWrite = "recorded" | "unchanged";

/** Atomic, tenant-keyed monotonic updates. A retry never extends an old failure. */
export class RecipientReachabilityStore {
  constructor(private readonly database: StoreDatabase = prisma) {}

  async recordFailure(
    shopId: string, recipient: string, failureAt: Date,
    providerCode: "131026",
  ): Promise<ReachabilityWrite> {
    const policy = await this.database.platformBillingPolicy.findUnique({
      where: { id: "default" },
      select: { whatsappRecipientSuppressionDays: true },
    });
    const days = policy?.whatsappRecipientSuppressionDays ?? 7;
    if (!Number.isSafeInteger(days) || days <= 0) {
      throw new Error("Invalid WhatsApp recipient suppression policy");
    }
    const until = new Date(failureAt.getTime() + days * DAY_MS);
    if (!Number.isFinite(until.getTime())) {
      throw new Error("WhatsApp recipient suppression exceeds supported date range");
    }
    const changed = await this.database.$queryRaw<Array<{ version: number }>>(Prisma.sql`
      INSERT INTO "whatsapp"."WhatsAppRecipientReachability"
        ("id", "shopId", "recipient", "lastProviderFailureCode",
         "lastFailureAt", "suppressUntil", "version", "createdAt", "updatedAt")
      VALUES (${randomUUID()},
        ${shopId}, ${recipient}, ${providerCode}, ${failureAt}, ${until}, 1, NOW(), NOW())
      ON CONFLICT ("shopId", "recipient") DO UPDATE SET
        "lastProviderFailureCode" = EXCLUDED."lastProviderFailureCode",
        "lastFailureAt" = EXCLUDED."lastFailureAt",
        "suppressUntil" = EXCLUDED."suppressUntil",
        "version" = "WhatsAppRecipientReachability"."version" + 1,
        "updatedAt" = NOW()
      WHERE ("WhatsAppRecipientReachability"."lastFailureAt" IS NULL OR
             "WhatsAppRecipientReachability"."lastFailureAt" < EXCLUDED."lastFailureAt")
        AND ("WhatsAppRecipientReachability"."lastSuccessfulAt" IS NULL OR
             "WhatsAppRecipientReachability"."lastSuccessfulAt" < EXCLUDED."lastFailureAt")
      RETURNING "version"
    `);
    return changed.length ? "recorded" : "unchanged";
  }

  async recordSuccess(
    shopId: string, recipient: string, successfulAt: Date,
  ): Promise<ReachabilityWrite> {
    // Insert positive-only evidence too: an older FAILED replay must not create
    // suppression simply because DELIVERED/READ arrived at the worker first.
    const changed = await this.database.$queryRaw<Array<{ version: number }>>(Prisma.sql`
      INSERT INTO "whatsapp"."WhatsAppRecipientReachability"
        ("id", "shopId", "recipient", "lastSuccessfulAt",
         "version", "createdAt", "updatedAt")
      VALUES (${randomUUID()},
        ${shopId}, ${recipient}, ${successfulAt}, 1, NOW(), NOW())
      ON CONFLICT ("shopId", "recipient") DO UPDATE SET
        "lastSuccessfulAt" = GREATEST(
          "WhatsAppRecipientReachability"."lastSuccessfulAt", EXCLUDED."lastSuccessfulAt"),
        "suppressUntil" = CASE
          WHEN "WhatsAppRecipientReachability"."lastFailureAt" IS NULL OR
               "WhatsAppRecipientReachability"."lastFailureAt" <= EXCLUDED."lastSuccessfulAt"
          THEN NULL ELSE "WhatsAppRecipientReachability"."suppressUntil" END,
        "version" = "WhatsAppRecipientReachability"."version" + 1,
        "updatedAt" = NOW()
      WHERE "WhatsAppRecipientReachability"."lastSuccessfulAt" IS NULL OR
            "WhatsAppRecipientReachability"."lastSuccessfulAt" < EXCLUDED."lastSuccessfulAt" OR
            ("WhatsAppRecipientReachability"."suppressUntil" IS NOT NULL AND
             "WhatsAppRecipientReachability"."lastFailureAt" <= EXCLUDED."lastSuccessfulAt")
      RETURNING "version"
    `);
    return changed.length ? "recorded" : "unchanged";
  }
}

export const recipientReachabilityStore = new RecipientReachabilityStore();
