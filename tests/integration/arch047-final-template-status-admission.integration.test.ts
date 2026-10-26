import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MetaTemplateRepository } from "../../src/services/meta-template-management/repository.js";
import { MetaTemplateManagementService } from "../../src/services/meta-template-management/service.js";
import { OutboundMessageDeliveryService } from
  "../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { OutboundProviderFailureService } from
  "../../src/services/outbound-whatsapp-admission/outbound-provider-failure.service.js";
import { WooInitialSendFenceService } from
  "../../src/services/woocommerce-recovery/woo-initial-send-fence.service.js";
import { BG006_WABA, seedApprovedWooTemplate, deferred, pausedObservation,
  failingMetaGet, expectUnadmittedAndUncharged } from
  "./fixtures/arch047-final-template-permit.fixture.js";

const url = process.env.TEST_DATABASE_URL;
const disposable = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

disposable("ARCH-047 BG003/BG006 SQL permit revocation and replay", () => {
  const clients: PrismaClient[] = [];
  const client = () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    clients.push(db);
    return db;
  };
  afterAll(async () => { await Promise.all(clients.map((db) => db.$disconnect())); });

  it("PAUSED receipt commits UNKNOWN before failed Meta GET; final permit denies without dispatch or charge", async () => {
    const observer = client(); const sender = client();
    const seeded = await seedApprovedWooTemplate(observer);
    const getEntered = deferred(); const releaseGet = deferred();
    const meta = failingMetaGet(async () => { getEntered.resolve(); await releaseGet.promise; });
    const service = new MetaTemplateManagementService(new MetaTemplateRepository(observer),
      meta.provider as never, meta.logger);
    const operations: Promise<unknown>[] = [];
    try {
      const observation = service.processTemplateStatusObservation(pausedObservation(seeded));
      operations.push(observation);
      await getEntered.promise; // BG003 receipt transaction committed before network GET
      const registration = await sender.whatsAppTemplateMetaRegistration.findUniqueOrThrow({
        where: { id: seeded.registrationId },
      });
      expect(registration.providerStatus).toBe("UNKNOWN");
      expect(registration.failureCode).toBe("STATUS_RECONCILIATION_PENDING");
      expect(await sender.whatsAppTemplateMetaEvent.count({ where: {
        registrationId: seeded.registrationId, source: "META_WEBHOOK",
        providerStatus: "PAUSED", outcome: "RECONCILIATION_PENDING", processedAt: null,
      } })).toBe(1);

      const permit = await new WooInitialSendFenceService(sender).admitFinalSend(seeded.input);
      expect(permit).toEqual({ kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" });
      await expectUnadmittedAndUncharged(sender, seeded);
      releaseGet.resolve();
      await expect(observation).rejects.toBe(meta.failure);
      expect(meta.provider.find).toHaveBeenCalledOnce();
      expect(meta.logger.error).toHaveBeenCalledWith("meta.template.webhook.error",
        expect.objectContaining({ code: "META_HTTP_503" }));
      expect((await sender.whatsAppTemplateMetaRegistration.findUniqueOrThrow({
        where: { id: seeded.registrationId },
      })).providerStatus).toBe("UNKNOWN");
      expect(await new WooInitialSendFenceService(sender).admitFinalSend(seeded.input))
        .toEqual({ kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" });

      // Exercise the ACTUAL provider-delivery adapter after the real SQL deny,
      // not a mock that merely pretends to dispatch when a permit succeeds.
      // Its existing failure adapter drops unadmitted usage, without changing
      // the separately owned recovery-credit reservation/compensation policy.
      const sendWhatsAppTemplate = vi.fn(async () => ({ providerMessageId: "forbidden" }));
      const provider = { getProviderAccountId: vi.fn(async () => BG006_WABA),
        sendWhatsAppTemplate, sendWhatsAppText: vi.fn() };
      const delivery = new OutboundMessageDeliveryService(sender,
        provider as never, { evaluate: vi.fn(async () => ({ allowed: true })) } as never,
        undefined, undefined,
        { assessText: vi.fn(async () => ({ kind: "allow" })),
          requireCurrentAllowance: vi.fn(async () => true) } as never,
        new OutboundProviderFailureService(sender), undefined, undefined,
        new WooInitialSendFenceService(sender));
      const result = await delivery.sendPreparedWooInitialTemplate({
        kind: "admitted", shopId: seeded.shopId, conversationId: seeded.input.conversationId,
        messageId: seeded.input.messageId, terminal: false, executionScope: "recovery",
      }, {
        to: seeded.input.recipient, templateName: seeded.input.templateName,
        languageCode: seeded.input.languageCode, templateRegistration: seeded.identity,
        recoveryPromise: { kind: "NO_OFFER" },
      }, {
        recoveryId: seeded.input.recoveryId, checkoutToken: seeded.input.checkoutToken,
        customerId: seeded.input.customerId, attemptId: seeded.input.attemptId,
        consent: seeded.input.consent, idempotencyKey: seeded.input.idempotencyKey,
        recoveryCreditSourceKey: seeded.input.recoveryCreditSourceKey,
      });
      expect(result).toEqual({ kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" });
      expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect((await sender.conversationMessage.findUniqueOrThrow({
        where: { id: seeded.input.messageId },
      }))).toMatchObject({ status: "FAILED", providerDispatchKey: null, providerDispatchAdmittedAt: null });
      expect(await sender.usageEvent.count({ where: { idempotencyKey: seeded.input.idempotencyKey } })).toBe(0);
      const counter = await sender.shopEntitlementCounter.findUniqueOrThrow({
        where: { shopId_counter: { shopId: seeded.shopId,
          counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
      });
      expect(counter.committedQuantity).toBe(0);
    } finally {
      releaseGet.resolve();
      await Promise.allSettled(operations);
    }
  }, 60_000);

  it("last approved Meta reconciliation older than 60 minutes is denied by the real final SQL permit", async () => {
    const db = client(); const seeded = await seedApprovedWooTemplate(db);
    await db.whatsAppTemplateMetaRegistration.update({
      where: { id: seeded.registrationId },
      data: { lastReconciledAt: new Date(Date.now() - 61 * 60_000) },
    });
    const providerDispatch = vi.fn(); const settleCharge = vi.fn();
    const result = await new WooInitialSendFenceService(db).admitFinalSend(seeded.input);
    if (result.kind === "admitted") { await providerDispatch(); await settleCharge(); }
    expect(result).toEqual({ kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_STALE" });
    expect(providerDispatch).not.toHaveBeenCalled();
    expect(settleCharge).not.toHaveBeenCalled();
    await expectUnadmittedAndUncharged(db, seeded);
  }, 45_000);
});
