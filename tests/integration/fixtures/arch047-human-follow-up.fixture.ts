import { randomUUID } from "node:crypto";
import type { FinalTemplateIdentity } from
  "../../../src/services/recovery-template-integration/final-template-registration.service.js";
import { humanDispatchFixture } from "./recovery-human-dispatch.fixture.js";

/** Real PostgreSQL fixture for BG007's immutable Moda-authored Follow-up
 * registration. It is intentionally shared by the final fence and failure/
 * recovery suites; each test owns a distinct WABA/template identity. */
export async function approvedMerchantFollowUpFixture(label: string) {
  // The ARCH-040 general fixture uses a fictitious 555 number for transport tests.
  // BG007 exercises real STOP phone matching, so use a valid E.164 recipient.
  // Existing ARCH-040 tests retain their original recipient.
  const f = await humanDispatchFixture(label, "447400123456");
  const token = randomUUID().replaceAll("-", "").slice(0, 20);
  const templateName = `arch047_human_${token}`;
  const hash = "a".repeat(64);
  const providerTemplateId = BigInt(`0x${token}`).toString(10);
  // Match the actual transport fixture's configured sender account; a
  // registration for some other WABA cannot authorise a merchant send.
  const senderWabaId = f.provider.getProviderAccountId();
  const admin = await f.db.platformAdmin.create({ data: {
    email: `arch047-human-${token}@example.invalid`,
  } });
  const definition = await f.db.whatsAppTemplateDefinition.create({ data: {
    kind: "META_RECOVERY", purpose: "FOLLOW_UP", offerType: "NO_OFFER",
    providerTemplateName: templateName, category: "MARKETING", status: "PUBLISHED",
    sourceLanguageTag: "en", astSchemaVersion: 1, sourceHash: "b".repeat(64),
    publishedAt: new Date(Date.now() - 60_000), createdByAdminId: admin.id,
  } });
  const locale = await f.db.whatsAppTemplateLocale.create({ data: {
    definitionId: definition.id, languageTag: "en", providerLanguageCode: "en_US",
    status: "REVIEWED", contentHash: hash, reviewedAt: new Date(),
    reviewedByAdminId: admin.id,
  } });
  const registration = await f.db.whatsAppTemplateMetaRegistration.create({ data: {
    localeId: locale.id, wabaId: senderWabaId, providerTemplateName: templateName,
    providerLanguageCode: "en_US", category: "MARKETING", componentsSnapshot: [],
    parameterBindingsSnapshot: { header: [], body: [], buttons: [] },
    submittedContentHash: hash, providerTemplateId,
    submissionState: "SUBMITTED", providerStatus: "APPROVED",
    lastObservedContentHash: hash, lastObservedCategory: "MARKETING",
    lastReconciledAt: new Date(Date.now() - 60_000),
  } });
  const variant = await f.db.whatsAppTemplateVariant.create({ data: {
    shopId: f.shopId, providerAccountId: senderWabaId, purpose: "FOLLOW_UP_NO_OFFER",
    languageTag: "en", providerLanguageCode: "en_US", providerTemplateName: templateName,
    providerTemplateId, metaRegistrationId: registration.id,
    status: "APPROVED", enabled: true,
  } });
  const identity: FinalTemplateIdentity = {
    shopId: f.shopId, senderWabaId, purpose: "FOLLOW_UP_NO_OFFER",
    variantId: variant.id, registrationId: registration.id, definitionId: definition.id,
    providerTemplateId, providerTemplateName: templateName, providerLanguageCode: "en_US",
    submittedContentHash: hash, bindingFingerprint: hash,
  };
  async function cleanup() {
    await f.db.whatsAppTemplateVariant.delete({ where: { id: variant.id } });
    await f.db.whatsAppTemplateMetaRegistration.delete({ where: { id: registration.id } });
    await f.db.whatsAppTemplateLocale.delete({ where: { id: locale.id } });
    await f.db.whatsAppTemplateDefinition.delete({ where: { id: definition.id } });
    await f.db.platformAdmin.delete({ where: { id: admin.id } });
    await f.close();
  }
  return { f, identity, registrationId: registration.id, cleanup };
}

/** Run the real command, sequence-two claim, and BG006 SQL fence together.
 * BG001 preparation itself is tested separately; this adapter supplies its
 * completed immutable payload without allowing merchant-authored parameters.
 */
export function preparedFollowUp(identity: FinalTemplateIdentity) {
  return { kind: "prepared" as const,
    prepared: { purpose: "FOLLOW_UP_NO_OFFER" },
    send: {
      templateName: identity.providerTemplateName, languageCode: identity.providerLanguageCode,
      textHeader: "Hello from the store", bodyParameters: ["Trusted customer"],
      dynamicUrlButton: { index: 0, text: "https%3A%2F%2Fstore.example.test%2Fcheckout" },
      recoveryPromise: { kind: "NO_OFFER" as const },
      templateRegistration: identity,
    },
  };
}
