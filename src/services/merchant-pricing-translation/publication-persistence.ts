import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import {
  buildMerchantPricingPublicationPayload,
  type MerchantPricingPublicationTranslationItemRow,
} from "./publication-payload.js";
import {
  MERCHANT_PRICING_PUBLICATION_SOURCE_SCHEMA_VERSION,
  canonicalMerchantPricingPublicationSource,
  currentMerchantPricingPublicationSource,
  merchantPricingPublicationSourceHash,
  merchantPricingPublicationSourcesMatch,
  type MerchantPricingPublicationHighlightTranslationRow,
  type MerchantPricingPublicationPlanRow,
  type MerchantPricingPublicationPlanTranslationRow,
} from "./publication-source.js";
import { replaceMerchantPricingTranslations } from "./publication-write.js";
import {
  MERCHANT_PRICING_INVALID_TRANSLATION_SET_FAILURE_CODE,
  MERCHANT_PRICING_SOURCE_CHANGED_FAILURE_CODE,
  MERCHANT_PRICING_UNSUPPORTED_SOURCE_SCHEMA_FAILURE_CODE,
  failMerchantPricingSourceChanged,
  failReadyMerchantPricingRun,
  markLinkedMerchantPricingPlanFailed,
} from "./publication-failure.js";
import type {
  MerchantPricingPublicationTransaction,
  MerchantPricingTranslationPublicationOutcome,
} from "./publication-types.js";

type TranslationRunRow = {
  id: string;
  shopifyPlanHandle: string;
  sourceSchemaVersion: number;
  sourceHash: string;
  sourceSnapshot: Prisma.JsonValue;
  status: string;
  requestedByAdminId: string;
  failureCode: string | null;
};

export async function finalizeMerchantPricingTranslationRun(
  transaction: MerchantPricingPublicationTransaction,
  translationRunId: string,
): Promise<MerchantPricingTranslationPublicationOutcome> {
  const runs = await transaction.$queryRaw<TranslationRunRow[]>(Prisma.sql`
    SELECT "id", "shopifyPlanHandle", "sourceSchemaVersion", "sourceHash",
      "sourceSnapshot", "status"::text AS "status", "requestedByAdminId", "failureCode"
    FROM "billing"."MerchantPricingTranslationRun"
    WHERE "id" = ${translationRunId}
    FOR UPDATE
  `);
  const run = runs[0];
  if (!run || !["READY_TO_APPLY", "FAILED", "STALE"].includes(run.status)) {
    return { status: "skipped", runId: translationRunId };
  }

  const plans = await transaction.$queryRaw<MerchantPricingPublicationPlanRow[]>(Prisma.sql`
    SELECT "id", "shopifyPlanHandle", "publicationStatus"::text AS "publicationStatus",
      "currentTranslationRunId", "isActive"
    FROM "billing"."MerchantPricingPlan"
    WHERE "currentTranslationRunId" = ${run.id}
    FOR UPDATE
  `);
  const plan = plans[0];
  if (!plan || plan.publicationStatus !== "TRANSLATING") {
    return { status: "skipped", runId: run.id };
  }

  if (run.status === "FAILED" || run.status === "STALE") {
    const failureCode =
      run.failureCode ??
      (run.status === "STALE"
        ? MERCHANT_PRICING_SOURCE_CHANGED_FAILURE_CODE
        : "TRANSLATION_FAILED");
    await markLinkedMerchantPricingPlanFailed(transaction, {
      runId: run.id,
      planId: plan.id,
      failureCode,
    });
    return {
      status: "failure-recorded",
      runId: run.id,
      planId: plan.id,
      failureCode,
    };
  }

  if (
    run.sourceSchemaVersion !== MERCHANT_PRICING_PUBLICATION_SOURCE_SCHEMA_VERSION
  ) {
    await failReadyMerchantPricingRun(transaction, {
      runId: run.id,
      planId: plan.id,
      failureCode: MERCHANT_PRICING_UNSUPPORTED_SOURCE_SCHEMA_FAILURE_CODE,
      status: "FAILED",
    });
    return {
      status: "failed",
      runId: run.id,
      planId: plan.id,
      failureCode: MERCHANT_PRICING_UNSUPPORTED_SOURCE_SCHEMA_FAILURE_CODE,
    };
  }

  const storedSource = canonicalMerchantPricingPublicationSource(run.sourceSnapshot);
  if (
    !storedSource ||
    run.shopifyPlanHandle !== storedSource.shopifyPlanHandle ||
    merchantPricingPublicationSourceHash(storedSource) !== run.sourceHash
  ) {
    return failMerchantPricingSourceChanged(transaction, run.id, plan.id);
  }

  const translations = await transaction.$queryRaw<
    MerchantPricingPublicationPlanTranslationRow[]
  >(Prisma.sql`
    SELECT "locale", "merchantDescription"
    FROM "billing"."MerchantPricingPlanTranslation"
    WHERE "merchantPricingPlanId" = ${plan.id}
    ORDER BY "locale"
  `);
  const highlights = await transaction.$queryRaw<
    MerchantPricingPublicationHighlightTranslationRow[]
  >(Prisma.sql`
    SELECT highlight."id" AS "highlightId", highlight."contentKey",
      translation."locale", translation."merchantTitle", translation."merchantDescription"
    FROM "billing"."MerchantPricingPlanHighlight" highlight
    LEFT JOIN "billing"."MerchantPricingPlanHighlightTranslation" translation
      ON translation."merchantPricingPlanHighlightId" = highlight."id"
    WHERE highlight."merchantPricingPlanId" = ${plan.id}
    ORDER BY highlight."contentKey", translation."locale"
  `);
  const currentSource = currentMerchantPricingPublicationSource({
    plan,
    translations,
    highlights,
  });
  if (
    !currentSource ||
    !merchantPricingPublicationSourcesMatch(storedSource, currentSource) ||
    plan.shopifyPlanHandle !== run.shopifyPlanHandle
  ) {
    return failMerchantPricingSourceChanged(transaction, run.id, plan.id);
  }

  const items = await transaction.$queryRaw<
    MerchantPricingPublicationTranslationItemRow[]
  >(Prisma.sql`
    SELECT "sourceEntityKind"::text AS "sourceEntityKind", "sourceContentKey",
      "sourceField"::text AS "sourceField", "sourceLanguageTag", "targetLanguageTag",
      "sourceText", "translatedText", "status"::text AS "status"
    FROM "billing"."MerchantPricingTranslationItem"
    WHERE "runId" = ${run.id}
    ORDER BY "targetLanguageTag", "sourceEntityKind", "sourceContentKey", "sourceField"
  `);
  const payload = buildMerchantPricingPublicationPayload({
    source: storedSource,
    items,
  });
  if (!payload) {
    await failReadyMerchantPricingRun(transaction, {
      runId: run.id,
      planId: plan.id,
      failureCode: MERCHANT_PRICING_INVALID_TRANSLATION_SET_FAILURE_CODE,
      status: "FAILED",
    });
    return {
      status: "failed",
      runId: run.id,
      planId: plan.id,
      failureCode: MERCHANT_PRICING_INVALID_TRANSLATION_SET_FAILURE_CODE,
    };
  }

  const highlightIdByContentKey = new Map(
    highlights.map((row) => [row.contentKey.toLowerCase(), row.highlightId]),
  );
  if (
    storedSource.highlights.some(
      (highlight) =>
        !highlightIdByContentKey.has(highlight.contentKey.toLowerCase()),
    )
  ) {
    return failMerchantPricingSourceChanged(transaction, run.id, plan.id);
  }

  await replaceMerchantPricingTranslations(transaction, {
    planId: plan.id,
    highlightIdByContentKey,
    payload,
  });

  const planChanged = await transaction.$executeRaw(Prisma.sql`
    UPDATE "billing"."MerchantPricingPlan"
    SET "publicationStatus" = 'READY', "currentTranslationRunId" = NULL,
      "isActive" = false, "updatedAt" = NOW()
    WHERE "id" = ${plan.id}
      AND "currentTranslationRunId" = ${run.id}
      AND "publicationStatus" = 'TRANSLATING'
      AND "isActive" = false
  `);
  if (planChanged !== 1) {
    throw new Error("Merchant Pricing draft changed during automatic finalisation");
  }

  const runChanged = await transaction.$executeRaw(Prisma.sql`
    UPDATE "billing"."MerchantPricingTranslationRun"
    SET "status" = 'APPLIED', "appliedAt" = NOW(), "completedAt" = NOW(),
      "appliedMerchantPricingPlanId" = ${plan.id}, "failureCode" = NULL, "updatedAt" = NOW()
    WHERE "id" = ${run.id} AND "status" = 'READY_TO_APPLY'
  `);
  if (runChanged !== 1) {
    throw new Error("Merchant Pricing translation run changed during automatic finalisation");
  }

  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO "billing"."BillingAuditEvent" (
      "id", "action", "platformAdminId", "reason", "relatedEntityType",
      "relatedEntityId", "createdAt"
    ) VALUES (
      ${randomUUID()}, 'PLAN_CATALOG_CHANGED', ${run.requestedByAdminId},
      'Merchant Pricing translations completed; plan is ready and inactive.',
      'MerchantPricingPlan', ${plan.id}, NOW()
    )
  `);

  return {
    status: "published",
    runId: run.id,
    planId: plan.id,
    planTranslationCount: payload.planTranslations.length,
    highlightTranslationCount: payload.highlightTranslations.length,
  };
}
