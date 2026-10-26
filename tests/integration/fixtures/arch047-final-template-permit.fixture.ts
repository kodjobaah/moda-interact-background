import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { expect, vi } from "vitest";
import { formatMetaTemplateStatusEventIdentity } from
  "@modainteract/moda-interact-shared/whatsapp-template-events";
import { MetaManagementError } from
  "../../../src/services/meta-template-management/contracts.js";
import type { FinalTemplateIdentity } from
  "../../../src/services/recovery-template-integration/final-template-registration.service.js";
import { seedWooInitialPermit } from "./woo-initial-send-fence.fixture.js";

export const BG006_WABA = "123456789";
export const BG006_HASH = "a".repeat(64);

/** A real frozen, published, reconciled Meta template attached to the Woo SQL
 * final-permit fixture. Nothing here bypasses schema constraints or consent
 * evidence. The integration runner owns disposal of the test database. */
export async function seedApprovedWooTemplate(db: PrismaClient) {
  const seeded = await seedWooInitialPermit(db);
  const token = randomUUID().replaceAll("-", "").slice(0, 20);
  const name = `moda_bg006_${token}`;
  // (wabaId, providerTemplateId) is globally unique across registrations.
  const providerId = BigInt(`0x${token}`).toString(10);
  const admin = await db.platformAdmin.create({ data: {
    email: `bg006-${token}@example.invalid`,
  } });
  const definition = await db.whatsAppTemplateDefinition.create({ data: {
    kind: "META_RECOVERY", purpose: "INITIAL", offerType: "NO_OFFER",
    providerTemplateName: name, category: "MARKETING", sourceLanguageTag: "en",
    astSchemaVersion: 1, sourceHash: "b".repeat(64), status: "PUBLISHED",
    publishedAt: new Date(Date.now() - 60_000), createdByAdminId: admin.id,
  } });
  const locale = await db.whatsAppTemplateLocale.create({ data: {
    definitionId: definition.id, languageTag: "en", providerLanguageCode: "en_GB",
    status: "REVIEWED", contentHash: BG006_HASH, reviewedAt: new Date(),
    reviewedByAdminId: admin.id,
  } });
  const registration = await db.whatsAppTemplateMetaRegistration.create({ data: {
    localeId: locale.id, wabaId: BG006_WABA,
    providerTemplateName: name, providerLanguageCode: "en_GB",
    category: "MARKETING", componentsSnapshot: [{ type: "BODY", text: "Welcome" }],
    parameterBindingsSnapshot: { header: [], body: [], buttons: [] },
    submittedContentHash: BG006_HASH, providerTemplateId: providerId,
    submissionState: "SUBMITTED", providerStatus: "APPROVED",
    lastObservedContentHash: BG006_HASH, lastObservedCategory: "MARKETING",
    lastReconciledAt: new Date(Date.now() - 60_000),
  } });
  const variant = await db.whatsAppTemplateVariant.create({ data: {
    shopId: seeded.shopId, providerAccountId: BG006_WABA,
    purpose: "INITIAL_NO_OFFER", languageTag: "en", providerLanguageCode: "en_GB",
    providerTemplateName: name, providerTemplateId: providerId,
    metaRegistrationId: registration.id, status: "APPROVED", enabled: true,
  } });
  const identity: FinalTemplateIdentity = {
    shopId: seeded.shopId, senderWabaId: BG006_WABA, purpose: "INITIAL_NO_OFFER",
    variantId: variant.id, registrationId: registration.id, definitionId: definition.id,
    providerTemplateId: providerId, providerTemplateName: name,
    providerLanguageCode: "en_GB", submittedContentHash: BG006_HASH,
    bindingFingerprint: BG006_HASH,
  };
  return {
    ...seeded, registrationId: registration.id, identity,
    input: { ...seeded.input, templateName: name, languageCode: "en_GB", templateRegistration: identity },
  };
}

/** Permit two independent recoveries against one immutable Meta registration.
 * Used to show that revocation fences the NEXT send after a prior permit wins. */
export async function seedSecondWooTemplatePermit(
  db: PrismaClient,
  template: Awaited<ReturnType<typeof seedApprovedWooTemplate>>,
) {
  const second = await seedWooInitialPermit(db);
  const variant = await db.whatsAppTemplateVariant.create({ data: {
    shopId: second.shopId, providerAccountId: BG006_WABA,
    purpose: "INITIAL_NO_OFFER", languageTag: "en", providerLanguageCode: "en_GB",
    providerTemplateName: template.identity.providerTemplateName,
    providerTemplateId: template.identity.providerTemplateId, metaRegistrationId: template.registrationId,
    status: "APPROVED", enabled: true,
  } });
  return { ...second, input: { ...second.input,
    templateName: template.identity.providerTemplateName, languageCode: "en_GB",
    templateRegistration: { ...template.identity, shopId: second.shopId, variantId: variant.id },
  } };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export function pausedObservation(template: Awaited<ReturnType<typeof seedApprovedWooTemplate>>) {
  return {
    eventIdentity: formatMetaTemplateStatusEventIdentity(randomUUID()),
    wabaId: BG006_WABA, providerTemplateId: template.identity.providerTemplateId,
    providerTemplateName: template.identity.providerTemplateName,
    providerLanguageCode: "en_GB", providerStatus: "PAUSED",
    occurredAt: new Date().toISOString(),
  };
}

export function failingMetaGet(onFind: () => Promise<void> = async () => {}) {
  const failure = new MetaManagementError("META_HTTP_503", "uncertain");
  return {
    failure,
    provider: {
      verifyWaba: vi.fn(async () => undefined),
      find: vi.fn(async () => { await onFind(); throw failure; }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

/** Read the durable charge boundary; the existing UsageEvent is a provisional
 * reservation, not a settled charge. Denying a permit must never commit credit. */
export async function expectUnadmittedAndUncharged(db: PrismaClient,
  seeded: Awaited<ReturnType<typeof seedApprovedWooTemplate>>) {
  const message = await db.conversationMessage.findUniqueOrThrow({
    where: { id: seeded.input.messageId },
  });
  expect(message.providerDispatchKey).toBeNull();
  expect(message.providerDispatchAdmittedAt).toBeNull();
  expect(message.status).toBe("PENDING");
  const credit = await db.usageReservation.findUniqueOrThrow({
    where: { sourceKey: seeded.input.recoveryCreditSourceKey },
  });
  expect(credit.status).toBe("RESERVED");
  const counter = await db.shopEntitlementCounter.findUniqueOrThrow({
    where: { shopId_counter: { shopId: seeded.shopId,
      counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
  });
  expect(counter.committedQuantity).toBe(0);
  expect(await db.usageEvent.count({
    where: { idempotencyKey: seeded.input.idempotencyKey },
  })).toBe(1); // existing reservation only; no second usage or charge
}
