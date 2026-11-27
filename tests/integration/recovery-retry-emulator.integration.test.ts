import { randomBytes, randomUUID } from "node:crypto";
import { RecoveryPolicyService } from "../../src/services/recovery-policy.service.js";
import { RecoveryOutreachFinalizationService } from "../../src/services/checkout-recovery/recovery-outreach-finalization.service.js";
import { RecoveryInitialOutreachSupportNoticeService } from "../../src/services/checkout-recovery/recovery-initial-outreach-support-notice.service.js";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { startArch040BackgroundMocks } from "./fixtures/arch040-background-mocks.fixture.js";
import { seedApprovedInitialWooTemplateRegistration, WOO_TEST_SENDER_WABA } from "./fixtures/woo-approved-initial-template.fixture.js";
import { recordWooDecision } from "./fixtures/woo-initial-send-fence.fixture.js";
import { PostgresModerationAssessmentService } from "../../src/services/conversation-moderation/moderation-assessment.service.js";
import { OutboundMessageDeliveryService } from "../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { WooGuardedInitialSenderService } from "../../src/services/woocommerce-recovery/woo-guarded-initial-sender.service.js";
import { WooRecoveryConsentReader } from "../../src/services/woocommerce-recovery-consent.service.js";
import { RecoveryStoredConsentService } from "../../src/services/recovery-conversation/recovery-stored-consent.service.js";
import { ShopifyWhatsAppConsentService } from "../../src/services/shopify-whatsapp-consent.service.js";
import { ShopExecutionEligibilityService } from "../../src/services/shop-execution-eligibility.service.js";
import { AiTurnOwnershipService } from "../../src/services/recovery-conversation/ai-turn-ownership.service.js";
import { OutboundSendFenceService } from "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { recoveryRuntimeEligibility } from "../../src/services/recovery-conversation/recovery-runtime-eligibility.service.js";
import { templateSendFields } from "../../src/services/recovery-template-integration/prepared-template-send.js";
import type { PreparedRecoveryTemplate } from "../../src/services/recovery-template-preparation/recovery-template.types.js";
import { describe, expect, it, vi } from "vitest";
import { retryOutreachAttemptId } from "../../src/domain/recovery-outreach-identity.js";
import { initialRetryExecutionPorts, InitialDeliveryRetryExecutionService } from "../../src/services/recovery-delivery-retry/execution.js";
import { RecoveryBillingService } from "../../src/services/recovery-billing.service.js";
import { OutboundWhatsAppAdmissionService } from "../../src/services/outbound-whatsapp-admission.service.js";
import { createInitialOutreachCreditFixture } from "./fixtures/arch056-initial-outreach-credit.fixture.js";
import { failure } from "./fixtures/recovery-retry-claim.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

// Provider boundary coverage: real SQL admission and persisted moderation;
// freeze a registered no-offer template to avoid external commerce/LLM reads.
// The loopback harness refuses any request to a different endpoint.
suite("Fresh initial retry through the local WhatsApp emulator", () => {
  it.each([
    { source: "free", recipient: "447400123481", timeout: false },
    { source: "purchased", recipient: "447400123482", timeout: false },
    { source: "free", recipient: "447400123483", timeout: true },
    { source: "purchased", recipient: "447400123484", timeout: true },
  ] as const)("dispatches $source retry, timeout=$timeout, without a duplicate request on restart", async ({ source, recipient, timeout }) => {
    const f = await createInitialOutreachCreditFixture({ source, recipient, sentAgeMs: 60 * 60_000 });
    let mocks: Awaited<ReturnType<typeof startArch040BackgroundMocks>> | undefined;
    vi.stubEnv("MODA_WOO_TEST_OUTBOUND", undefined);
    try {
      const site = `https://${f.shopId}.example.test`;
      const woo = f.provider === "WOOCOMMERCE";
      await f.db.shop.update({ where: { id: f.shopId }, data: { domain: woo ? site : `${f.shopId}.example.test`, onboardingCompleted: true, defaultCountryCode: "GB", defaultLanguageTag: "en-GB" } });
      await f.db.shopSettings.create({ data: { shopId: f.shopId, recoveryOfferMode: "NONE", followUpEnabled: false, notifyOnInitialRecoveryOutreach: false } });
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
      const identity = await seedApprovedInitialWooTemplateRegistration(f.db, f.shopId, site);
      const config = await f.db.platformConfiguration.upsert({ where: { environment_key: { environment: "test", key: "messaging.sender" } },
        create: { environment: "test", key: "messaging.sender", value: { fixture: true }, version: 1 },
        update: { value: { fixture: true }, version: 1 } });
      mocks = await startArch040BackgroundMocks({ rowId: config.id, version: config.version, providerAccountId: WOO_TEST_SENDER_WABA, standalonePhoneNumberId: "15550123457" });
      const s = await failure(f, "131016", { phone: mocks.whatsapp.phoneNumberId, account: WOO_TEST_SENDER_WABA, recipient });
      const attemptId = retryOutreachAttemptId(s.intent.id);
      const log = createLogger({ serviceName: "retry-emulator-integration", environment: "test" });
      const ports = initialRetryExecutionPorts();
      ports.billing = new RecoveryBillingService(f.db);
      ports.policy = new RecoveryPolicyService(f.db);
      ports.execution = new ShopExecutionEligibilityService(f.db);
      ports.wooConsent = new WooRecoveryConsentReader(f.db);
      ports.shopifyConsent = new RecoveryStoredConsentService(f.db, new ShopifyWhatsAppConsentService(f.db));
      const moderation = new PostgresModerationAssessmentService(f.db, async () => ({ flagged: false, categories: { harassment: false },
        categoryScores: { harassment: 0.01 }, returnedModel: "omni-moderation-latest" }), undefined, async () => ({
        moderation: { key: "omini.moderation", version: 1, value: { baseUrl: "http://127.0.0.1:1/v1/moderations", modelId: "omni-moderation-latest" } },
        providerVersion: 1, openAiApiKey: "retry-disposable-test-only",
      }));
      const ownership = new AiTurnOwnershipService(f.db);
      const fence = new OutboundSendFenceService(f.db, recoveryRuntimeEligibility);
      ports.outbound = new OutboundWhatsAppAdmissionService(f.db, undefined, mocks.provider as never, undefined, ports.execution,
        undefined, moderation, ownership, fence, ports.shopifyConsent);
      ports.wooSender = new WooGuardedInitialSenderService(ports.orders, log, ports.outbound,
        new OutboundMessageDeliveryService(f.db, mocks.provider as never, ports.execution, ownership, fence, moderation));
      ports.finalizer = new RecoveryOutreachFinalizationService(ports.billing, new RecoveryInitialOutreachSupportNoticeService(f.db), undefined, f.db);
      const prepared: PreparedRecoveryTemplate = { ...identity, outcome: "prepared", canonicalLanguageTag: "en-GB", selectionSource: "exact",
        initialCheckoutItemsBodyPosition: 2, template: { name: identity.providerTemplateName, language: { code: identity.providerLanguageCode },
          components: [{ type: "body", parameters: [{ type: "text", text: "Example Shop" }, { type: "text", text: "1 × Test item" }] },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "retry-checkout" }] }] } };
      vi.spyOn(ports.template, "prepare").mockResolvedValue({ kind: "prepared", prepared, send: templateSendFields(prepared, { kind: "NO_OFFER" }) });
      if (timeout) mocks.failNextHttp("timeout");
      const executor = new InitialDeliveryRetryExecutionService(f.db, ports, log);
      if (timeout) await expect(executor.execute(s.intent.id)).rejects.toThrow();
      else expect(await executor.execute(s.intent.id)).toMatchObject({ kind: "reconciled", messageId: expect.any(String) });
      expect(mocks.requests).toEqual([{ type: "template" }]);
      if (!timeout) expect((await mocks.whatsapp.waitForMessageCount(1))[0]?.body).toMatchObject({ type: "template", template: { name: identity.providerTemplateName } });
      const restart = new InitialDeliveryRetryExecutionService(f.db, ports, log);
      expect(await restart.execute(s.intent.id)).toMatchObject(timeout ? { kind: "held", reason: "provider-outcome-unknown" } : { kind: "reconciled" });
      expect(mocks.requests).toHaveLength(1);
      const attempt = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(attempt).toMatchObject(timeout ? { status: "PENDING", outboundMessageId: null } : { status: "WAITING_FOR_RESPONSE", outboundMessageId: expect.any(String) });
      expect(await f.db.usageReservation.count({ where: { shopId: f.shopId, status: timeout ? "RESERVED" : "COMMITTED", compensatedAt: null } })).toBe(1);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: s.reservation.id } })).toEqual(s.reservation);
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: f.attemptId } })).toEqual(s.original);
      expect(await f.db.conversationMessage.count({ where: { conversationId: s.conversation.id } })).toBe(2);
    } finally {
      try { await mocks?.close(); } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await f.close();
      }
    }
  }, 60_000);
});
