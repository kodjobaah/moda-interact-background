import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { RecoveryPolicyService } from "../../src/services/recovery-policy.service.js";
import { prepareCompensatedFollowUp, registerHistoricalSender } from "./fixtures/follow-up-retry.fixture.js";
import { startArch040BackgroundMocks } from "./fixtures/arch040-background-mocks.fixture.js";
import { seedApprovedInitialWooTemplateRegistration, WOO_TEST_SENDER_WABA } from "./fixtures/woo-approved-initial-template.fixture.js";
import { recordWooDecision } from "./fixtures/woo-initial-send-fence.fixture.js";
import { PostgresModerationAssessmentService } from "../../src/services/conversation-moderation/moderation-assessment.service.js";
import { WooRecoveryConsentReader } from "../../src/services/woocommerce-recovery-consent.service.js";
import { RecoveryStoredConsentService } from "../../src/services/recovery-conversation/recovery-stored-consent.service.js";
import { ShopifyWhatsAppConsentService } from "../../src/services/shopify-whatsapp-consent.service.js";
import { ShopExecutionEligibilityService } from "../../src/services/shop-execution-eligibility.service.js";
import { AiTurnOwnershipService } from "../../src/services/recovery-conversation/ai-turn-ownership.service.js";
import { OutboundSendFenceService } from "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { recoveryRuntimeEligibility } from "../../src/services/recovery-conversation/recovery-runtime-eligibility.service.js";
import { templateSendFields } from "../../src/services/recovery-template-integration/prepared-template-send.js";
import type { PreparedRecoveryTemplate } from "../../src/services/recovery-template-preparation/recovery-template.types.js";
import { retryOutreachAttemptId } from "../../src/domain/recovery-outreach-identity.js";
import { followUpRetryBlockId } from "../../src/domain/recovery-follow-up-retry-allowance.js";
import { ScheduledFollowUpRetryExecutionService, scheduledFollowUpRetryExecutionPorts, listDueScheduledFollowUpRetries } from "../../src/services/recovery-delivery-retry/follow-up-execution.js";
import { ScheduledFollowUpRetryFundingService } from "../../src/services/recovery-delivery-retry/follow-up-funding.js";
import { recoveryDeliveryNoticeSourceKey } from "../../src/services/recovery-delivery-notification-content.js";
import { RecoveryDeliveryCompensationService } from "../../src/services/recovery-delivery-compensation/reconcile.service.js";

const suite = process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

// Real registered sender, PostgreSQL funding/permit/moderation and loopback
// WhatsApp transport. Only the external template resolver and moderation API
// are isolated; no billing, dispatch fence or settlement is stubbed.
suite("Scheduled follow-up retry through the local WhatsApp emulator", () => {
  it.each([
    { source: "free", recipient: "447400123491", outcome: "accepted" },
    { source: "purchased", recipient: "447400123492", outcome: "accepted" },
    { source: "free", recipient: "447400123493", outcome: "timeout" },
    { source: "purchased", recipient: "447400123494", outcome: "timeout" },
    { source: "free", recipient: "447400123495", outcome: "provider-rejected" },
    { source: "purchased", recipient: "447400123496", outcome: "recipient-undeliverable" },
  ] as const)("$source $outcome: dispatches at most once across restart", async ({ source, recipient, outcome }) => {
    const t = await prepareCompensatedFollowUp(source, recipient);
    const { f } = t;
    let mocks: Awaited<ReturnType<typeof startArch040BackgroundMocks>> | undefined;
    try {
      const site = `https://${f.shopId}.example.test`;
      const woo = f.provider === "WOOCOMMERCE";
      await f.db.shop.update({ where: { id: f.shopId }, data: { domain: woo ? site : `${f.shopId}.example.test`, onboardingCompleted: true, defaultCountryCode: "GB", defaultLanguageTag: "en-GB" } });
      await f.db.shopSettings.create({ data: { shopId: f.shopId, recoveryOfferMode: "NONE", followUpEnabled: true, followUpDelayMinutes: 30, notifyOnInitialRecoveryOutreach: false } });
      const customer = await f.db.customer.create({ data: { shopId: f.shopId, phone: `+${recipient}`,
        ...(woo ? {} : { shopifyCustomerId: "123456789" }) } });
      if (woo) {
        const installation = await f.db.wooCommerceInstallation.create({ data: { shopId: f.shopId, canonicalSiteUrl: site, credentialDigest: Uint8Array.from(randomBytes(32)) } });
        const phone = await f.db.customerPhone.create({ data: { customerId: customer.id, phone: `+${recipient}` } });
        await recordWooDecision(f.db, { shopId: f.shopId, installationId: installation.id, customerId: customer.id, customerPhoneId: phone.id }, "GRANT", recipient);
      } else {
        // ARCH-077 evidence must be created atomically with the projection.
        const observed = new Date();
        await f.db.$transaction(async tx => {
          const phone = await tx.customerPhone.create({ data: { customerId: customer.id, phone: `+${recipient}`,
            whatsappCanonicalPhone: recipient, whatsappPhoneVerifiedAt: observed, whatsappConsentDecision: "GRANTED",
            whatsappConsentSource: "SHOPIFY_NATIVE", whatsappConsentVerifiedAt: observed, whatsappConsentProviderObservedAt: observed,
            whatsappConsentRevision: 1n, whatsappConsentDecisionSequence: 1n } });
          await tx.whatsAppConsentEvidence.create({ data: { shopId: f.shopId, installationId: null, eventId: randomUUID(), customerId: customer.id,
            customerPhoneId: phone.id, canonicalPhone: recipient, purpose: "WHATSAPP_CHECKOUT_RECOVERY", decision: "GRANT", decisionAt: observed,
            decisionSequence: 1n, phoneConsentRevision: 1n, payloadDigest: Uint8Array.from(randomBytes(32)),
            disclosureText: "Receive checkout recovery messages on WhatsApp.", disclosureVersion: "1", disclosureLocale: "en-GB" } });
        });
      }
      await f.db.checkoutRecovery.update({ where: { id: f.recoveryId }, data: { customerId: customer.id, checkoutUrl: `${site}/checkout` } });
      const identity = await seedApprovedInitialWooTemplateRegistration(f.db, f.shopId, site, false, WOO_TEST_SENDER_WABA, "FOLLOW_UP");
      const config = await f.db.platformConfiguration.upsert({ where: { environment_key: { environment: "test", key: "messaging.sender" } },
        create: { environment: "test", key: "messaging.sender", value: { fixture: true }, version: 1 },
        update: { value: { fixture: true }, version: 1 } });
      // Sender inventory survives individual tests in the disposable database.
      // These six distinct synthetic recipients define distinct numeric sender IDs
      // in a test-only range, separate from the standalone and other pooled fixtures.
      const pooledPhoneNumberId = `94${recipient}`;
      mocks = await startArch040BackgroundMocks({ rowId: config.id, version: config.version,
        providerAccountId: WOO_TEST_SENDER_WABA, standalonePhoneNumberId: "15550123457", pooledPhoneNumberId });
      await registerHistoricalSender(t, { phone: mocks.whatsapp.phoneNumberId, account: WOO_TEST_SENDER_WABA });
      const attemptId = retryOutreachAttemptId(t.intent.id);
      const scope = { shopId: f.shopId, recoveryId: f.recoveryId, conversationId: t.conversation.id, intentId: t.intent.id };
      const log = createLogger({ serviceName: "follow-up-retry-emulator-integration", environment: "test" });
      const ports = scheduledFollowUpRetryExecutionPorts();
      ports.policy = new RecoveryPolicyService(f.db);
      ports.execution = new ShopExecutionEligibilityService(f.db);
      ports.consent = new RecoveryStoredConsentService(f.db, new ShopifyWhatsAppConsentService(f.db), undefined, new WooRecoveryConsentReader(f.db));
      const moderation = new PostgresModerationAssessmentService(f.db, async () => ({ flagged: false, categories: { harassment: false },
        categoryScores: { harassment: 0.01 }, returnedModel: "omni-moderation-latest" }), undefined, async () => ({
        moderation: { key: "omini.moderation", version: 1, value: { baseUrl: "http://127.0.0.1:1/v1/moderations", modelId: "omni-moderation-latest" } },
        providerVersion: 1, openAiApiKey: "retry-disposable-test-only",
      }));
      const ownership = new AiTurnOwnershipService(f.db);
      const fence = new OutboundSendFenceService(f.db, recoveryRuntimeEligibility);
      ports.ownership = ownership;
      ports.fence = fence;
      ports.moderation = moderation;
      ports.provider = { ...mocks.provider, getProviderAccountId: async () => WOO_TEST_SENDER_WABA };
      const prepared: PreparedRecoveryTemplate = { ...identity, outcome: "prepared", canonicalLanguageTag: "en-GB", selectionSource: "exact",
        initialCheckoutItemsBodyPosition: null, template: { name: identity.providerTemplateName, language: { code: identity.providerLanguageCode },
          components: [{ type: "body", parameters: [{ type: "text", text: "Example Shop" }] },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "retry-checkout" }] }] } };
      vi.spyOn(ports.template, "prepare").mockResolvedValue({ kind: "prepared", prepared, send: templateSendFields(prepared, { kind: "NO_OFFER" }) });
      expect(await listDueScheduledFollowUpRetries(f.db, { now: new Date(), limit: 250 })).toContainEqual({ id: t.intent.id, notBeforeAt: t.intent.notBeforeAt });
      // Timeout cases also exercise resumption after the funding transaction.
      const funded = outcome === "timeout" ? await new ScheduledFollowUpRetryFundingService(f.db).claimAndFund(scope) : undefined;
      if (funded && funded.kind !== "funded") throw new Error(`Expected funded retry, received ${funded.kind}`);
      const oldAttempt = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: t.attemptId } });
      const oldCredit = await f.db.usageReservation.findUniqueOrThrow({ where: { id: t.reservation.id } });
      const oldBlock = await f.db.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: t.block.id } });
      if (outcome !== "accepted") mocks.failNextHttp(outcome);
      const worker = new ScheduledFollowUpRetryExecutionService(f.db, ports, log);
      if (outcome === "timeout") await expect(worker.execute(t.intent.id)).rejects.toThrow("mock WhatsApp transport timeout (provider outcome unknown)");
      else if (outcome === "provider-rejected" || outcome === "recipient-undeliverable") await expect(worker.execute(t.intent.id)).rejects.toThrow("WhatsApp provider rejected the template");
      else {
        expect(await worker.execute(t.intent.id)).toMatchObject({ kind: "settled", reservationId: expect.any(String) });
        expect((await mocks.whatsapp.waitForMessageCount(1))[0]?.body).toMatchObject({ type: "template", template: { name: identity.providerTemplateName } });
      }
      expect(mocks.requests).toEqual([{ type: "template" }]);
      const restarted = new ScheduledFollowUpRetryExecutionService(f.db, ports, log);
      expect(await restarted.execute(t.intent.id)).toMatchObject(outcome === "timeout" ? { kind: "held", reason: "opening-unknown" }
        : { kind: "unchanged", reason: outcome === "accepted" ? "block-active" : outcome === "recipient-undeliverable" ? "recipient-failure-notified" : "block-cancelled" });
      expect(mocks.requests).toHaveLength(1);
      const block = await f.db.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: followUpRetryBlockId(attemptId) } });
      expect(block).toMatchObject({ state: outcome === "accepted" ? "ACTIVE" : outcome === "timeout" ? "PENDING" : "CANCELLED", creditReservationId: expect.any(String) });
      if (funded && funded.kind === "funded") expect(block.creditReservationId).toBe(funded.reservationId);
      const credit = await f.db.usageReservation.findUniqueOrThrow({ where: { id: block.creditReservationId! } });
      expect(credit.status).toBe(outcome === "accepted" ? "COMMITTED" : outcome === "timeout" ? "RESERVED" : "RELEASED");
      const message = await f.db.conversationMessage.findFirstOrThrow({ where: { allowanceBlockId: block.id } });
      expect(message).toMatchObject({ senderType: "AUTOMATION", providerDispatchKey: expect.any(String), dispatchProviderPhoneNumberId: mocks.whatsapp.phoneNumberId,
        status: outcome === "accepted" ? "SENT" : outcome === "timeout" ? "PENDING" : "FAILED" });
      const attempt = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(attempt).toMatchObject({ sequence: 3, trigger: "NO_RESPONSE_FOLLOW_UP", status: outcome === "accepted" ? "WAITING_FOR_RESPONSE" : outcome === "timeout" ? "PENDING" : "FAILED",
        outboundMessageId: outcome === "timeout" ? null : message.id, followUpDueAt: null });
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: t.attemptId } })).toEqual(oldAttempt);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: t.reservation.id } })).toEqual(oldCredit);
      expect(await f.db.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: t.block.id } })).toEqual(oldBlock);
      expect(await f.db.conversationMessage.count({ where: { conversationId: t.conversation.id } })).toBe(3);
      if (outcome === "recipient-undeliverable") {
        expect(message.providerFailureCode).toBe("131026");
        expect(await f.db.whatsAppRecipientReachability.findUnique({ where: { shopId_recipient: { shopId: f.shopId, recipient } } })).toMatchObject({ lastProviderFailureCode: "131026", suppressUntil: expect.any(Date) });
        expect(await f.db.merchantSupportMessage.findUnique({ where: { sourceKey: recoveryDeliveryNoticeSourceKey(f.shopId, f.recoveryId, message.id) } })).not.toBeNull();
      }
      if (outcome === "accepted") {
        await f.db.conversationMessage.update({ where: { id: message.id }, data: { status: "FAILED", providerFailureCode: "131016", failedAt: new Date() } });
        expect(await new RecoveryDeliveryCompensationService(f.db).reconcile(message.providerMessageId!)).toBe("restored-spendable");
        expect(await f.db.recoveryOutreachRetryIntent.findUniqueOrThrow({ where: { failedAttemptId: attemptId } })).toMatchObject({ fundingReservationId: credit.id, failedMessageId: message.id });
        expect(await f.db.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: block.id } })).toMatchObject({ state: "CANCELLED" });
        expect(mocks.requests).toHaveLength(1);
      }
    } finally {
      try { await mocks?.close(); } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f.close(); }
    }
  }, 60_000);
});
