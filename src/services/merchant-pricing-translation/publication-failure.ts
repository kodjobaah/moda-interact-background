import { Prisma } from "@prisma/client";

import type {
  MerchantPricingPublicationTransaction,
  MerchantPricingTranslationPublicationOutcome,
} from "./publication-types.js";

export const MERCHANT_PRICING_SOURCE_CHANGED_FAILURE_CODE = "SOURCE_CHANGED";
export const MERCHANT_PRICING_INVALID_TRANSLATION_SET_FAILURE_CODE =
  "TRANSLATION_SET_INVALID";
export const MERCHANT_PRICING_UNSUPPORTED_SOURCE_SCHEMA_FAILURE_CODE =
  "UNSUPPORTED_SOURCE_SCHEMA";

export async function markLinkedMerchantPricingPlanFailed(
  transaction: MerchantPricingPublicationTransaction,
  input: {
    runId: string;
    planId: string;
    failureCode: string;
  },
): Promise<void> {
  const changed = await transaction.$executeRaw(Prisma.sql`
    UPDATE "billing"."MerchantPricingPlan"
    SET "publicationStatus" = 'TRANSLATION_FAILED', "isActive" = false, "updatedAt" = NOW()
    WHERE "id" = ${input.planId}
      AND "currentTranslationRunId" = ${input.runId}
      AND "publicationStatus" = 'TRANSLATING'
  `);
  if (changed !== 1) {
    throw new Error(`Merchant Pricing draft changed while recording ${input.failureCode}`);
  }
}

export async function failReadyMerchantPricingRun(
  transaction: MerchantPricingPublicationTransaction,
  input: {
    runId: string;
    planId: string;
    failureCode: string;
    status: "FAILED" | "STALE";
  },
): Promise<void> {
  const runChanged = await transaction.$executeRaw(Prisma.sql`
    UPDATE "billing"."MerchantPricingTranslationRun"
    SET "status" = ${input.status}::"billing"."MerchantPricingTranslationRunStatus",
      "failureCode" = ${input.failureCode}, "completedAt" = NOW(), "updatedAt" = NOW()
    WHERE "id" = ${input.runId} AND "status" = 'READY_TO_APPLY'
  `);
  if (runChanged !== 1) {
    throw new Error("Merchant Pricing translation run changed during automatic finalisation");
  }
  await markLinkedMerchantPricingPlanFailed(transaction, input);
}

export async function failMerchantPricingSourceChanged(
  transaction: MerchantPricingPublicationTransaction,
  runId: string,
  planId: string,
): Promise<MerchantPricingTranslationPublicationOutcome> {
  await failReadyMerchantPricingRun(transaction, {
    runId,
    planId,
    failureCode: MERCHANT_PRICING_SOURCE_CHANGED_FAILURE_CODE,
    status: "STALE",
  });
  return {
    status: "stale",
    runId,
    planId,
    failureCode: MERCHANT_PRICING_SOURCE_CHANGED_FAILURE_CODE,
  };
}
