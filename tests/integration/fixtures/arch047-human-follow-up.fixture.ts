import { observedContentHash } from "../../../src/services/meta-template-management/contracts.js";
import { randomUUID } from "node:crypto";
import type { FinalTemplateIdentity } from
  "../../../src/services/recovery-template-integration/final-template-registration.service.js";
import { humanDispatchFixture } from "./recovery-human-dispatch.fixture.js";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { RecoveryAllowanceService } from "../../../src/services/recovery-allowance/renewal.service.js";

/** Real PostgreSQL fixture for BG007's immutable Moda-authored Follow-up
 * registration. It is intentionally shared by the final fence and failure/
 * recovery suites; each test owns a distinct template identity within the disposable WABA. */
export async function approvedMerchantFollowUpFixture(label: string) {
  // The ARCH-040 general fixture uses a fictitious 555 number for transport tests.
  // BG007 exercises real STOP phone matching, so use a valid E.164 recipient.
  // Existing ARCH-040 tests retain their original recipient.
  const f = await humanDispatchFixture(label, { recipient: "447400123456", pooledSender: true });
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
    providerLanguageCode: "en_US", category: "MARKETING", componentsSnapshot: [{ type: "BODY", text: "Your checkout is waiting" }],
    parameterBindingsSnapshot: { header: [], body: [], buttons: [] },
    submittedContentHash: hash, providerTemplateId,
    submissionState: "SUBMITTED", providerStatus: "APPROVED",
    lastObservedContentHash: observedContentHash([{ type: "BODY", text: "Your checkout is waiting" }]), lastObservedCategory: "MARKETING",
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
  // The historical BG007 billing mock only returned a sourceKey. The current
  // final fence needs a real, exact FOLLOW_UP reservation attached to a PENDING
  // allowance block. Seed the original committed credit and use the production
  // allowance begin/attach services; no billing policy or provider call is mocked
  // inside the final SQL fence. Negative scenarios can still override admission.
  const allowances = new RecoveryAllowanceService(f.db);
  async function reserveFollowUp(attemptId: string) {
    const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
    const prior = await f.db.usageReservation.findUnique({ where: { sourceKey } });
    if (prior) {
      const block = await f.db.conversationAllowanceBlock.findFirst({ where: {
        conversationId: f.conversationId, creditReservationId: prior.id, fundingKind: "FOLLOW_UP", state: "PENDING",
      } });
      if (!block || prior.shopId !== f.shopId || prior.status !== "RESERVED" || !prior.counterId) {
        throw new Error("Fixture follow-up funding evidence mismatch");
      }
      return { sourceKey, counterId: prior.counterId, reservationId: prior.id };
    }
    const original = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: {
      checkoutRecoveryId_sequence: { checkoutRecoveryId: f.recoveryId, sequence: 1 },
    } });
    const originalKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${original.id}`);
    const counterId = await f.db.$transaction(async tx => {
      const counter = await tx.shopEntitlementCounter.create({ data: {
        shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 2, committedQuantity: 1,
      } });
      const reservation = await tx.usageReservation.create({ data: {
        shopId: f.shopId, counterId: counter.id, sourceKey: originalKey, quantity: 1, status: "COMMITTED",
      } });
      const usage = await tx.usageEvent.create({ data: {
        shopId: f.shopId, provider: "SHOPIFY", metric: "RECOVERY_CONVERSATION", quantity: 1,
        sourceType: "FREE_RECOVERY_RESERVATION", sourceId: reservation.id,
        idempotencyKey: createRecoveryIdempotencyKey(f.shopId, originalKey),
      } });
      await tx.usageReservation.update({ where: { id: reservation.id }, data: { committedUsageEventId: usage.id } });
      if (!original.outboundMessageId) throw new Error("Fixture original outreach receipt missing");
      await tx.usageEvent.create({ data: {
        shopId: f.shopId, provider: "SHOPIFY", metric: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1,
        sourceType: "OUTBOUND_AUTOMATED_MESSAGE", sourceId: original.outboundMessageId,
        idempotencyKey: `recovery-outreach:${original.id}`,
      } });
      return counter.id;
    });
    const intent = await allowances.beginFollowUp({ shopId: f.shopId, recoveryId: f.recoveryId,
      attemptId, limits: { outboundHardLimit: 20, terminalMessageReservedSlots: 1 } });
    const reserved = await f.db.$transaction(async tx => {
      await tx.shopEntitlementCounter.update({ where: { id: counterId }, data: { reservedQuantity: { increment: 1 } } });
      return tx.usageReservation.create({ data: {
        shopId: f.shopId, counterId, sourceKey, quantity: 1, status: "RESERVED",
      } });
    });
    await allowances.attachFollowUp(intent, sourceKey);
    return { sourceKey, counterId, reservationId: reserved.id };
  }
  f.billing.admitAndRevalidate.mockImplementation(async input => {
    const { sourceKey } = await reserveFollowUp(input.sequenceTwoAttemptId);
    return { kind: "admitted", admission: { sourceKey } };
  });

  async function cleanup() {
    await f.db.whatsAppTemplateVariant.delete({ where: { id: variant.id } });
    await f.db.whatsAppTemplateMetaRegistration.delete({ where: { id: registration.id } });
    await f.db.whatsAppTemplateLocale.delete({ where: { id: locale.id } });
    await f.db.whatsAppTemplateDefinition.delete({ where: { id: definition.id } });
    await f.db.platformAdmin.delete({ where: { id: admin.id } });
    await f.close();
  }
  return { f, identity, registrationId: registration.id, reserveFollowUp, cleanup };
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
