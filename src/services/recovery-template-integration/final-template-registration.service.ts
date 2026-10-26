import type { PreparedRecoveryTemplate } from "../recovery-template-preparation/recovery-template.types.js";
import type { SqlTransaction } from "../recovery-conversation/recovery-conversation.sql.js";
import { first } from "../recovery-conversation/recovery-conversation.sql.js";

/** Snapshot identity only. This is NOT a permission token: the locked database
 * projection and the latest provider observation are decisive at dispatch. */
export type FinalTemplateIdentity = Readonly<Pick<PreparedRecoveryTemplate,
  "shopId" | "senderWabaId" | "purpose" | "variantId" | "registrationId" |
  "definitionId" | "providerTemplateId" | "providerTemplateName" |
  "providerLanguageCode" | "submittedContentHash" | "bindingFingerprint">>;

export type FinalTemplateDenial =
  | "TEMPLATE_REGISTRATION_UNAVAILABLE"
  | "TEMPLATE_PROVIDER_STATUS_UNRESOLVED"
  | "TEMPLATE_PROVIDER_STATUS_STALE";

export type FinalTemplateEligibility = (
  transaction: SqlTransaction,
  identity: FinalTemplateIdentity,
  now: Date,
) => Promise<FinalTemplateDenial | null>;

const MAX_APPROVAL_AGE_MS = 60 * 60_000;

type LockedRegistration = {
  variantId: string; registrationId: string; shopId: string; purpose: string;
  wabaId: string; providerTemplateName: string; providerLanguageCode: string;
  providerTemplateId: string | null; submittedContentHash: string;
  variantStatus: string; enabled: boolean; category: string;
  providerStatus: string | null; submissionState: string; failureCode: string | null;
  lastReconciledAt: Date | null; lastObservedContentHash: string | null;
  lastObservedCategory: string | null; driftDetectedAt: Date | null;
  definitionId: string; definitionStatus: string; definitionKind: string;
  definitionPurpose: string | null; definitionOfferType: string | null;
  definitionName: string | null; definitionCategory: string | null;
  publishedAt: Date | null; retiredAt: Date | null;
  localeStatus: string; localeContentHash: string | null;
  localeLanguageCode: string | null; unresolvedObservation: boolean;
};

/**
 * Must run INSIDE the already-held final SQL permit transaction, after the Shop
 * lock and BEFORE the irreversible providerDispatchAdmittedAt write. Locking the
 * exact variant, registration, locale and definition serialises a concurrent
 * Admin disable / BG003 provider revocation against the permit. No Meta or Redis.
 */
export const checkFinalTemplateRegistration: FinalTemplateEligibility = async (tx, template, now) => {
  if (!template?.shopId || !template.variantId || !template.registrationId ||
      !template.senderWabaId || !template.providerTemplateId ||
      !Number.isFinite(now.getTime())) return "TEMPLATE_REGISTRATION_UNAVAILABLE";

  const current = await first<LockedRegistration>(tx, `
    SELECT v."id" AS "variantId", r."id" AS "registrationId", v."shopId",
      v."purpose", r."wabaId", r."providerTemplateName", r."providerLanguageCode",
      r."providerTemplateId", r."submittedContentHash",
      v."status"::text AS "variantStatus", v."enabled", r."category",
      r."providerStatus", r."submissionState", r."failureCode",
      r."lastReconciledAt", r."lastObservedContentHash", r."lastObservedCategory",
      r."driftDetectedAt", d."id" AS "definitionId", d."status" AS "definitionStatus",
      d."kind" AS "definitionKind", d."purpose" AS "definitionPurpose",
      d."offerType" AS "definitionOfferType", d."providerTemplateName" AS "definitionName",
      d."category" AS "definitionCategory", d."publishedAt", d."retiredAt",
      l."status" AS "localeStatus", l."contentHash" AS "localeContentHash",
      l."providerLanguageCode" AS "localeLanguageCode",
      EXISTS (
        SELECT 1 FROM "whatsapp"."WhatsAppTemplateMetaEvent" e
        WHERE e."registrationId"=r."id" AND e."source"='META_WEBHOOK'
          AND e."outcome"='RECONCILIATION_PENDING' AND e."processedAt" IS NULL
      ) AS "unresolvedObservation"
    FROM "whatsapp"."WhatsAppTemplateVariant" v
    JOIN "whatsapp"."WhatsAppTemplateMetaRegistration" r ON r."id"=v."metaRegistrationId"
    JOIN "whatsapp"."WhatsAppTemplateLocale" l ON l."id"=r."localeId"
    JOIN "whatsapp"."WhatsAppTemplateDefinition" d ON d."id"=l."definitionId"
    WHERE v."id"=$1 AND v."shopId"=$2 AND r."id"=$3
    FOR SHARE OF v,r,l,d`, template.variantId, template.shopId, template.registrationId);

  if (!current || current.variantId !== template.variantId ||
      current.registrationId !== template.registrationId ||
      current.shopId !== template.shopId || current.purpose !== template.purpose ||
      current.wabaId !== template.senderWabaId ||
      current.providerTemplateId !== template.providerTemplateId ||
      current.providerTemplateName !== template.providerTemplateName ||
      current.providerLanguageCode !== template.providerLanguageCode ||
      current.variantStatus !== "APPROVED" || current.enabled !== true ||
      current.category !== "MARKETING" ||
      current.definitionId !== template.definitionId ||
      current.definitionKind !== "META_RECOVERY" ||
      current.definitionStatus !== "PUBLISHED" ||
      current.definitionPurpose !== (template.purpose.startsWith("INITIAL_") ? "INITIAL" : "FOLLOW_UP") ||
      current.definitionOfferType !== template.purpose.replace(/^(INITIAL|FOLLOW_UP)_/, "") ||
      current.definitionName !== template.providerTemplateName ||
      current.definitionCategory !== "MARKETING" || !current.publishedAt || current.retiredAt ||
      current.localeStatus !== "REVIEWED" ||
      current.localeLanguageCode !== template.providerLanguageCode ||
      current.localeContentHash !== template.submittedContentHash ||
      current.submittedContentHash !== template.submittedContentHash ||
      current.submittedContentHash !== template.bindingFingerprint ||
      !/^[a-f0-9]{64}$/.test(template.bindingFingerprint)) {
    return "TEMPLATE_REGISTRATION_UNAVAILABLE";
  }
  if (current.providerStatus !== "APPROVED" ||
      !["SUBMITTED", "CONFIRMED", "APPROVED"].includes(current.submissionState) ||
      current.failureCode !== null || current.driftDetectedAt !== null ||
      current.lastObservedCategory !== "MARKETING" ||
      current.lastObservedContentHash !== current.submittedContentHash ||
      current.unresolvedObservation) {
    return "TEMPLATE_PROVIDER_STATUS_UNRESOLVED";
  }
  if (!(current.lastReconciledAt instanceof Date) ||
      !Number.isFinite(current.lastReconciledAt.getTime()) ||
      now.getTime() < current.lastReconciledAt.getTime() ||
      now.getTime() - current.lastReconciledAt.getTime() > MAX_APPROVAL_AGE_MS) {
    return "TEMPLATE_PROVIDER_STATUS_STALE";
  }
  return null;
};
