import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FinalTemplateIdentity } from
  "../../../src/services/recovery-template-integration/final-template-registration.service.js";

/** A disposable, Moda-authored and provider-reconciled Marketing registration.
 * Its immutable frozen projection must pass both ARCH-047 preparation and the
 * ARCH-046 final SQL permit; a legacy unlinked variant cannot grant a send.
 */
export const WOO_TEST_SENDER_WABA = "987654321";

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

export async function seedApprovedInitialWooTemplateRegistration(
  db: PrismaClient, shopId: string, shopUrl: string, includeCheckoutItemsBinding = true,
): Promise<FinalTemplateIdentity> {
  const components = [
    { type: "BODY", text: includeCheckoutItemsBinding
      ? "{{1}}: {{2}}. Your checkout is waiting. Reply to this message with text or a voice note (up to two minutes)."
      : "{{1}}: Your checkout is waiting. Reply to this message with text or a voice note (up to two minutes)." },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Resume checkout", url: `${shopUrl}/checkout?url={{1}}` }] },
  ];
  const bindings = {
    schemaVersion: 1,
    promotionTarget: "CHECKOUT",
    header: [],
    body: includeCheckoutItemsBinding
      ? [{ position: 1, variable: "shop.name" }, { position: 2, variable: "checkout.itemsSummary" }]
      : [{ position: 1, variable: "shop.name" }],
    buttons: [{ index: 0, subType: "url", variable: "checkout.url" }],
  };
  const suffix = randomUUID().replaceAll("-", "");
  const name = `moda_woo_${suffix}`;
  const providerId = BigInt(`0x${suffix}`).toString(10);
  const contentHash = createHash("sha256").update(stableJson({
    schemaVersion: 1, family: "META_RECOVERY", category: "MARKETING",
    components, parameterBindings: bindings,
  })).digest("hex");
  const admin = await db.platformAdmin.create({ data: {
    email: `woo-template-${suffix}@example.invalid`,
  } });
  const definition = await db.whatsAppTemplateDefinition.create({ data: {
    kind: "META_RECOVERY", purpose: "INITIAL", offerType: "NO_OFFER",
    providerTemplateName: name, category: "MARKETING",
    sourceLanguageTag: "en-GB", astSchemaVersion: 1,
    sourceHash: contentHash, status: "PUBLISHED",
    publishedAt: new Date(Date.now() - 60_000), createdByAdminId: admin.id,
  } });
  const locale = await db.whatsAppTemplateLocale.create({ data: {
    definitionId: definition.id, languageTag: "en-GB", providerLanguageCode: "en_GB",
    status: "REVIEWED", contentHash, reviewedByAdminId: admin.id,
    reviewedAt: new Date(Date.now() - 60_000),
  } });
  const registration = await db.whatsAppTemplateMetaRegistration.create({ data: {
    localeId: locale.id, wabaId: WOO_TEST_SENDER_WABA,
    providerTemplateName: name, providerLanguageCode: "en_GB",
    category: "MARKETING", componentsSnapshot: components,
    parameterBindingsSnapshot: bindings, submittedContentHash: contentHash,
    providerTemplateId: providerId, submissionState: "SUBMITTED", providerStatus: "APPROVED",
    lastObservedContentHash: contentHash, lastObservedCategory: "MARKETING",
    lastReconciledAt: new Date(Date.now() - 30_000),
  } });
  const variant = await db.whatsAppTemplateVariant.create({ data: {
    shopId, providerAccountId: WOO_TEST_SENDER_WABA,
    purpose: "INITIAL_NO_OFFER", languageTag: "en-GB",
    providerLanguageCode: "en_GB", providerTemplateName: name,
    providerTemplateId: providerId, metaRegistrationId: registration.id,
    status: "APPROVED", enabled: true,
  } });
  return {
    shopId, senderWabaId: WOO_TEST_SENDER_WABA, purpose: "INITIAL_NO_OFFER",
    variantId: variant.id, registrationId: registration.id, definitionId: definition.id,
    providerTemplateId: providerId, providerTemplateName: name,
    providerLanguageCode: "en_GB", submittedContentHash: contentHash,
    bindingFingerprint: contentHash,
  };
}
