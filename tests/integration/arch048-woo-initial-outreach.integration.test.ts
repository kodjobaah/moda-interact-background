import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { RECOVERY_OUTREACH_FOLLOW_UP_QUEUE, createRecoveryOutreachFollowUpJobId } from "../../src/domain/recovery-outreach-follow-up.js";
import { recoveryOutreachFollowUpService } from "../../src/services/recovery-outreach-follow-up.service.js";
import { RecoveryFollowUpPolicyService } from "../../src/services/recovery-conversation/recovery-follow-up-policy.service.js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { outboundWhatsAppAdmissionService } from "../../src/services/outbound-whatsapp-admission.service.js";
import { platformConsumerConfiguration } from "../../src/services/platform-configuration/consumers.js";
import { recoveryBillingService } from "../../src/services/recovery-billing.service.js";
import { conversationService } from "../../src/services/conversation.service.js";
import { whatsAppService } from "../../src/services/whatsapp.service.js";
import { recoverySenderPoolService } from "../../src/services/recovery-sender-pool/sender-pool.service.js";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import type { WhatsAppInboundEvent } from "../../src/integration/whatsapp/types.js";
import { RecoveryRoutingService } from "../../src/services/recovery-routing.service.js";
import { WOO_TEST_SENDER_WABA } from "./fixtures/woo-approved-initial-template.fixture.js";
import {
  createWooOutreachFixture, mockWooOutreachSenderConfiguration, recordWooFixtureReceipt,
  WOO_TEST_PRODUCT_ID, type WooOutreachIntegrationFixture,
} from "./fixtures/arch048-woo-outreach.fixture.js";
import { mockWooOutreachCatalogue } from "./fixtures/woo-outreach-catalogue.fixture.js";

const integration = process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

integration("ARCH-048-BACKGROUND-004 Woo initial outreach (disposable Postgres + Redis)", () => {
  let f: WooOutreachIntegrationFixture | undefined;
  let catalogueReads: ReturnType<typeof mockWooOutreachCatalogue>;

  beforeEach(async () => {
    catalogueReads = mockWooOutreachCatalogue();
    vi.spyOn(outboundWhatsAppAdmissionService, "getProviderAccountId")
      .mockResolvedValue(WOO_TEST_SENDER_WABA);
    vi.spyOn(whatsAppService, "getProviderAccountId")
      .mockResolvedValue(WOO_TEST_SENDER_WABA);
    // The frozen registration, approval, category and language are persisted
    // in the disposable DB; the provider transport is still controlled.
    f = await createWooOutreachFixture();
    mockWooOutreachSenderConfiguration(f.senderConfiguration);
  }, 90_000);

  afterEach(async () => {
    try { if (f) await f.cleanup(); }
    finally { f = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  }, 90_000);

  it("creates only one durable sequence-1 attempt and one BullMQ job across concurrent DB-locked requests", async () => {
    const a = f!;
    const enqueued = await Promise.all([
      a.service.enqueueInitial(a.recoveryId),
      a.service.enqueueInitial(a.recoveryId),
    ]);
    expect(enqueued.map((r) => r.kind)).toEqual(["queued", "queued"]);
    expect(enqueued[0]).toEqual(enqueued[1]);
    const attempts = await a.db.recoveryOutreachAttempt.findMany({
      where: { checkoutRecoveryId: a.recoveryId },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ sequence: 1, status: "PENDING", followUpDueAt: null });
    expect(await a.queue.getJobCounts("waiting", "active", "completed", "failed"))
      .toMatchObject({ waiting: 1, active: 0, completed: 0, failed: 0 });
    expect(await a.db.usageReservation.count({ where: { shopId: a.shopId } })).toBe(0);
    const job = await a.queue.getJob(`arch048-${attempts[0]!.id}`);
    expect(job?.data).toMatchObject({ recoveryId: a.recoveryId, attemptId: attempts[0]!.id });
  }, 90_000);

  it("does not send or reserve/commit billing when the approved initial template lacks the basket binding", async () => {
    await f!.cleanup();
    f = undefined;
    f = await createWooOutreachFixture({ includeCheckoutItemsBinding: false });
    const a = f;
    // Reinstall within the same test to exercise the previous recursive mock
    // failure deterministically, without relying on a timed-out setup hook.
    mockWooOutreachSenderConfiguration(a.senderConfiguration);
    await expect(platformConsumerConfiguration.read("messaging.sender")).resolves.toMatchObject({
      rowId: a.senderConfiguration.id, version: a.senderConfiguration.version,
    });
    // A non-sender read must still use the real configuration service.
    await expect(platformConsumerConfiguration.read("commerce.recoveryExecution"))
      .resolves.toMatchObject({ key: "commerce.recoveryExecution" });
    await a.service.enqueueInitial(a.recoveryId);

    await expect(a.service.processInitial(a.recoveryId)).resolves.toMatchObject({
      kind: "suppressed", reason: "marketing-template-unavailable",
    });
    expect(a.providerRequests).toBe(0);
    expect(await a.db.usageReservation.count({ where: { shopId: a.shopId } })).toBe(0);
    expect(await a.db.usageEvent.count({ where: { shopId: a.shopId, metric: "RECOVERY_CONVERSATION" } }))
      .toBe(0);
  }, 90_000);

  it("persists exactly one confirmed send, Free credit charge and usage event under concurrent dispatch/replay", async () => {
    const a = f!;
    await a.service.enqueueInitial(a.recoveryId);
    const dispatched = await Promise.all([
      a.service.processInitial(a.recoveryId),
      a.service.processInitial(a.recoveryId),
    ]);
    expect(dispatched.map((r) => r.kind).sort()).toEqual(["already-initialized", "sent"]);
    expect(a.providerRequests).toBe(1);
    expect(catalogueReads.mock.calls.map(([name, args]) => ({ name, args }))).toEqual([
      { name: "commerce_get_product", args: { productId: WOO_TEST_PRODUCT_ID, variantId: null } },
      { name: "commerce_get_product", args: { productId: WOO_TEST_PRODUCT_ID, variantId: null } },
    ]);
    expect((await a.db.checkoutRecovery.findUniqueOrThrow({ where: { id: a.recoveryId } })).status)
      .toBe("MESSAGE_SENT");
    const attempts = await a.db.recoveryOutreachAttempt.findMany({ where: { checkoutRecoveryId: a.recoveryId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      sequence: 1, status: "WAITING_FOR_RESPONSE", followUpDueAt: null,
    });
    expect(attempts[0]!.outboundMessageId).toBeTruthy();
    expect(await a.db.conversationMessage.count({ where: {
      id: attempts[0]!.outboundMessageId!, status: "SENT", direction: "OUTBOUND",
    } })).toBe(1);
    const admittedMessage = await a.db.conversationMessage.findUniqueOrThrow({
      where: { id: attempts[0]!.outboundMessageId! },
      select: { providerDispatchKey: true, providerDispatchAdmittedAt: true, providerDispatchControlRevision: true },
    });
    expect(admittedMessage.providerDispatchKey).toBe(`recovery-outreach:${attempts[0]!.id}`);
    expect(admittedMessage.providerDispatchAdmittedAt).not.toBeNull();
    expect(admittedMessage.providerDispatchControlRevision).toBe(0);
    const reservations = await a.db.usageReservation.findMany({ where: { shopId: a.shopId } });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ status: "COMMITTED", quantity: 1 });
    expect(await a.db.usageEvent.count({ where: {
      shopId: a.shopId, metric: "RECOVERY_CONVERSATION",
    } })).toBe(1);
    const counter = await a.db.shopEntitlementCounter.findUniqueOrThrow({
      where: { shopId_counter: { shopId: a.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
    });
    expect(counter).toMatchObject({ committedQuantity: 1, reservedQuantity: 0 });
    await expect(a.service.processInitial(a.recoveryId)).resolves.toMatchObject({ kind: "already-initialized" });
    expect(a.providerRequests).toBe(1);
    expect(await a.db.usageEvent.count({ where: { shopId: a.shopId, metric: "RECOVERY_CONVERSATION" } })).toBe(1);
  }, 90_000);

  it("publishes one configured Woo follow-up, restores a missing job, and claims only one due slot", async () => {
    const a = f!;
    await a.db.shopSettings.update({ where: { shopId: a.shopId }, data: {
      followUpEnabled: true, followUpDelayMinutes: 60,
    } });
    const queue = new Queue(RECOVERY_OUTREACH_FOLLOW_UP_QUEUE, { connection: a.redis });
    let jobId: string | undefined;
    try {
      await expect(a.service.enqueueInitial(a.recoveryId)).resolves.toMatchObject({ kind: "queued" });
      await expect(a.service.processInitial(a.recoveryId)).resolves.toMatchObject({ kind: "sent" });
      const initial = await a.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: {
        checkoutRecoveryId_sequence: { checkoutRecoveryId: a.recoveryId, sequence: 1 },
      } });
      expect(initial.sentAt).not.toBeNull();
      const due = new Date(initial.sentAt!.getTime() + 60 * 60_000);
      expect(initial.followUpDueAt).toEqual(due);
      const jobData = { checkoutRecoveryId: a.recoveryId, sequence: 2 as const };
      jobId = createRecoveryOutreachFollowUpJobId(jobData, due);
      const job = await queue.getJob(jobId);
      expect(job?.data).toEqual(jobData);
      expect(await job?.getState()).toBe("delayed");
      await job!.remove();
      // Replaying a confirmed initial must repair publication, not contact the
      // provider again, create a new attempt or calculate a new due time.
      await expect(a.service.processInitial(a.recoveryId)).resolves.toMatchObject({ kind: "already-initialized" });
      await expect(a.service.enqueueInitial(a.recoveryId)).resolves.toMatchObject({ kind: "already-initialized" });
      expect((await queue.getJob(jobId))?.data).toEqual(jobData);
      expect((await queue.getJobs(["delayed", "waiting"])).filter(item => item.data.checkoutRecoveryId === a.recoveryId)).toHaveLength(1);
      expect(a.providerRequests).toBe(1);
      expect(await a.db.usageReservation.count({ where: { shopId: a.shopId } })).toBe(1);
      expect(await a.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: a.recoveryId, sequence: 2 } })).toBe(0);

      const policy = new RecoveryFollowUpPolicyService(a.db);
      const claim = { recoveryId: a.recoveryId, initiator: "scheduled_no_response" as const,
        initiationKey: `scheduled-no-response:${a.recoveryId}`, recipient: initial.recipient };
      await expect(policy.claimSequenceTwo({ ...claim, now: new Date(due.getTime() - 1) }))
        .resolves.toEqual({ kind: "suppressed", reason: "follow-up-not-due" });
      expect(await a.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: a.recoveryId, sequence: 2 } })).toBe(0);
      // Advance only the policy clock, not durable timestamps or test timeouts.
      await expect(policy.claimSequenceTwo({ ...claim, now: due })).resolves.toMatchObject({ kind: "claimed" });
      await expect(policy.claimSequenceTwo({ ...claim, now: due })).resolves.toEqual({ kind: "suppressed", reason: "already-claimed" });
      expect(await a.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: a.recoveryId, sequence: 2 } })).toBe(1);
      expect(a.providerRequests).toBe(1);
      expect(await a.db.usageReservation.count({ where: { shopId: a.shopId } })).toBe(1);
    } finally {
      if (jobId) await (await queue.getJob(jobId))?.remove();
      await queue.close();
      await recoveryOutreachFollowUpService.close();
    }
  }, 90_000);

  it("keeps shared-sender confirmed sends and quoted replies isolated by merchant", async () => {
    const first = f!;
    const second = await createWooOutreachFixture();
    try {
      const [firstShop, secondShop] = await Promise.all([
        first.db.shop.findUniqueOrThrow({ where: { id: first.shopId }, select: { domain: true } }),
        second.db.shop.findUniqueOrThrow({ where: { id: second.shopId }, select: { domain: true } }),
      ]);
      await Promise.all([
        first.service.enqueueInitial(first.recoveryId),
        second.service.enqueueInitial(second.recoveryId),
      ]);

      const outcomes = await Promise.all([
        first.service.processInitial(first.recoveryId),
        first.service.processInitial(first.recoveryId),
        second.service.processInitial(second.recoveryId),
        second.service.processInitial(second.recoveryId),
      ]);
        expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
          "already-initialized", "already-initialized", "sent", "sent",
        ]);
      expect(first.providerRequests).toBe(1);
      expect(second.providerRequests).toBe(1);
      expect(first.providerTemplateRequests).toMatchObject([{
        shopId: first.shopId, recoveryId: first.recoveryId,
        bodyParameters: [firstShop.domain, "1 × Test item"],
      }]);
      expect(second.providerTemplateRequests).toMatchObject([{
        shopId: second.shopId, recoveryId: second.recoveryId,
        bodyParameters: [secondShop.domain, "1 × Test item"],
      }]);

      const attempts = await Promise.all([
        first.db.recoveryOutreachAttempt.findUniqueOrThrow({
          where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: first.recoveryId, sequence: 1 } },
        }),
        second.db.recoveryOutreachAttempt.findUniqueOrThrow({
          where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: second.recoveryId, sequence: 1 } },
        }),
      ]);
      const messages = await Promise.all(attempts.map((attempt) => first.db.conversationMessage.findUniqueOrThrow({
        where: { id: attempt.outboundMessageId! },
        include: { conversation: { select: { checkoutRecovery: { select: { id: true, shopId: true } } } } },
      })));
      expect(messages[0]).toMatchObject({
        direction: "OUTBOUND", status: "SENT", providerMessageId: expect.any(String),
        conversation: { checkoutRecovery: { id: first.recoveryId, shopId: first.shopId } },
      });
      expect(messages[1]).toMatchObject({
        direction: "OUTBOUND", status: "SENT", providerMessageId: expect.any(String),
        conversation: { checkoutRecovery: { id: second.recoveryId, shopId: second.shopId } },
      });
      expect(attempts[0]!.outboundMessageId).toBe(messages[0]!.id);
      expect(attempts[1]!.outboundMessageId).toBe(messages[1]!.id);
      expect(messages[0]!.providerMessageId).not.toBe(messages[1]!.providerMessageId);

      const routing = new RecoveryRoutingService(first.db, { isShopExecutionActive: async () => true });
      const routes = await Promise.all(messages.map((message, index) => {
        expect(message.dispatchProviderAccountId).toBe(WOO_TEST_SENDER_WABA);
        expect(message.dispatchProviderPhoneNumberId).toBeTruthy();
        const event: WhatsAppInboundEvent = {
          schemaVersion: 1, provider: "whatsapp", providerAccountId: message.dispatchProviderAccountId!,
          providerPhoneNumberId: message.dispatchProviderPhoneNumberId!, providerMessageId: `inbound-${index}-${randomUUID()}`,
          customerPhone: "+447400123456", contextMessageId: message.providerMessageId!,
          occurredAt: new Date().toISOString(), content: { type: "text", text: "Help" },
        };
        return routing.resolveInboundMessage(event);
      }));
      expect(routes[0]).toMatchObject({
        kind: "resolved", shopId: first.shopId, checkoutRecoveryId: first.recoveryId,
        conversationId: messages[0]!.conversationId,
      });
      expect(routes[1]).toMatchObject({
        kind: "resolved", shopId: second.shopId, checkoutRecoveryId: second.recoveryId,
        conversationId: messages[1]!.conversationId,
      });

      await Promise.all([
        first.service.processInitial(first.recoveryId),
        second.service.processInitial(second.recoveryId),
      ]);
      expect(first.providerRequests).toBe(1);
      expect(second.providerRequests).toBe(1);
      expect(await first.db.usageEvent.count({
        where: { shopId: first.shopId, metric: "RECOVERY_CONVERSATION" },
      })).toBe(1);
      expect(await first.db.usageEvent.count({
        where: { shopId: second.shopId, metric: "RECOVERY_CONVERSATION" },
      })).toBe(1);
        expect(await first.db.conversationMessage.count({
          where: { conversationId: messages[0]!.conversationId, direction: "OUTBOUND", status: "SENT" },
        })).toBe(1);
        expect(await first.db.conversationMessage.count({
          where: { conversationId: messages[1]!.conversationId, direction: "OUTBOUND", status: "SENT" },
        })).toBe(1);
    } finally {
      await second.cleanup();
    }
  }, 90_000);

  it("cancels a resumed generation, releases its reserved free credit once, and permits generation two independently", async () => {
    const a = f!;
    expect(await a.service.enqueueInitial(a.recoveryId)).toMatchObject({ kind: "queued" });
    const oldAttempt = await a.db.recoveryOutreachAttempt.findUniqueOrThrow({
      where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: a.recoveryId, sequence: 1 } },
    });
    const oldAdmission = await recoveryBillingService.admit({
      shopId: a.shopId, recoveryId: a.recoveryId, outreachAttemptId: oldAttempt.id,
    });
    expect(oldAdmission.kind).toBe("admitted");
    await a.resumePreviousRecovery();

    await a.service.settleResumed(a.recoveryId);
    await a.service.settleResumed(a.recoveryId);
    const oldSettled = await a.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: oldAttempt.id } });
    expect(oldSettled).toMatchObject({ status: "CANCELLED", sentAt: null, outboundMessageId: null });
    expect(oldSettled.closedAt).not.toBeNull();
    const oldReservation = await a.db.usageReservation.findUniqueOrThrow({ where: { sourceKey: oldAdmission.kind === "admitted" ? oldAdmission.admission.sourceKey : "" } });
    expect(oldReservation).toMatchObject({ status: "RELEASED", quantity: 1 });
    const freeCounter = await a.db.shopEntitlementCounter.findUniqueOrThrow({
      where: { shopId_counter: { shopId: a.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
    });
    expect(freeCounter).toMatchObject({ committedQuantity: 0, reservedQuantity: 0 });

    const next = await a.db.checkoutRecovery.create({ data: {
      shopId: a.shopId, customerId: a.customerId, checkoutToken: a.checkoutToken,
      generation: 2, status: "DETECTED", lastExternalActivityAt: new Date(),
      currency: "GBP", checkoutUrl: `${a.shopUrl}/checkout/${a.checkoutToken}`,
      lineItems: [{ productId: WOO_TEST_PRODUCT_ID, variantId: null, title: "Test item", quantity: 1, price: "10.00" }],
    } });
    expect(await a.service.enqueueInitial(next.id)).toMatchObject({ kind: "queued" });
    const newAttempt = await a.db.recoveryOutreachAttempt.findUniqueOrThrow({
      where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: next.id, sequence: 1 } },
    });
    expect(newAttempt.id).not.toBe(oldAttempt.id);
    expect((await a.queue.getJob(`arch048-${newAttempt.id}`))?.data)
      .toMatchObject({ recoveryId: next.id, attemptId: newAttempt.id });
    expect(await a.service.processInitial(next.id)).toMatchObject({ kind: "sent", attemptId: newAttempt.id });
    expect(a.providerRequests).toBe(1);
    const nextReservation = await a.db.usageReservation.findFirstOrThrow({
      where: { shopId: a.shopId, sourceKey: { not: oldReservation.sourceKey } },
    });
    expect(nextReservation).toMatchObject({ status: "COMMITTED", quantity: 1 });
    expect(nextReservation.sourceKey).not.toBe(oldReservation.sourceKey);
  }, 90_000);

  it("fails closed when follow-up state prevents the conditional cancellation and retains its reservation", async () => {
    const a = f!;
    await a.service.enqueueInitial(a.recoveryId);
    const attempt = await a.db.recoveryOutreachAttempt.findUniqueOrThrow({
      where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: a.recoveryId, sequence: 1 } },
    });
    const admission = await recoveryBillingService.admit({
      shopId: a.shopId, recoveryId: a.recoveryId, outreachAttemptId: attempt.id,
    });
    expect(admission.kind).toBe("admitted");
    const followUpDueAt = new Date(Date.now() + 60_000);
    await a.db.recoveryOutreachAttempt.update({ where: { id: attempt.id }, data: { followUpDueAt } });
    await a.resumePreviousRecovery();

    await expect(a.service.settleResumed(a.recoveryId))
      .rejects.toThrow("WOO_RESUMED_FOLLOW_UP_ATTEMPT_NOT_CANCELLABLE");
    expect(await a.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))
      .toMatchObject({ status: "PENDING", followUpDueAt });
    expect(await a.db.usageReservation.findUniqueOrThrow({ where: { sourceKey: admission.kind === "admitted" ? admission.admission.sourceKey : "" } }))
      .toMatchObject({ status: "RESERVED", quantity: 1 });
    expect(a.providerRequests).toBe(0);
  }, 90_000);

  it("replays a validated already-cancelled pre-permit attempt without changing its released credit", async () => {
    const a = f!;
    await a.service.enqueueInitial(a.recoveryId);
    const attempt = await a.db.recoveryOutreachAttempt.findUniqueOrThrow({
      where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: a.recoveryId, sequence: 1 } },
    });
    const admission = await recoveryBillingService.admit({
      shopId: a.shopId, recoveryId: a.recoveryId, outreachAttemptId: attempt.id,
    });
    expect(admission.kind).toBe("admitted");
    await a.resumePreviousRecovery();

    await a.service.settleResumed(a.recoveryId);
    const cancelled = await a.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(cancelled).toMatchObject({
      checkoutRecoveryId: a.recoveryId, sequence: 1, status: "CANCELLED",
      sentAt: null, outboundMessageId: null, followUpDueAt: null,
    });
    const sourceKey = admission.kind === "admitted" ? admission.admission.sourceKey : "";
    const released = await a.db.usageReservation.findUniqueOrThrow({ where: { sourceKey } });
    expect(released).toMatchObject({ status: "RELEASED", quantity: 1 });

    await expect(a.service.settleResumed(a.recoveryId)).resolves.toBeUndefined();
    expect(await a.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))
      .toMatchObject({ id: attempt.id, status: "CANCELLED", followUpDueAt: null });
    expect(await a.db.usageReservation.findUniqueOrThrow({ where: { sourceKey } }))
      .toMatchObject({ status: "RELEASED", quantity: 1 });
  }, 90_000);

  it("reconciles a confirmed provider send after resumption when attempt finalization did not commit", async () => {
    const a = f!;
    await a.service.enqueueInitial(a.recoveryId);
    const attempt = await a.db.recoveryOutreachAttempt.findUniqueOrThrow({
      where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: a.recoveryId, sequence: 1 } },
    });
    const admission = await recoveryBillingService.admit({
      shopId: a.shopId, recoveryId: a.recoveryId, outreachAttemptId: attempt.id,
    });
    expect(admission.kind).toBe("admitted");
    const conversation = await conversationService.getOrCreateRecoveryConversation(a.recoveryId);
    const control = await a.db.conversation.findUniqueOrThrow({
      where: { id: conversation.id }, select: { controlRevision: true },
    });
    const sentAt = new Date();
    const allocated = await recoverySenderPoolService.allocate({ conversationId: conversation.id,
      canonicalRecipient: "447400123456", initialAttemptId: attempt.id });
    expect(allocated.kind).toBe("assigned");
    const message = await recordWooFixtureReceipt(a.db, {
      shopId: a.shopId, conversationId: conversation.id, recipient: "447400123456",
      content: "Integration-only confirmed template", sentAt,
      idempotencyKey: `recovery-outreach:${attempt.id}`, controlRevision: control.controlRevision,
      providerMessageId: `wamid-resumed-${randomUUID()}`,
    });
    // Simulate worker termination after the durable provider result but before
    // RecoveryOutreachAttempt finalisation: attempt identity remains unset.
    await a.resumePreviousRecovery();

    await a.service.settleResumed(a.recoveryId);
    const reconciled = await a.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(reconciled).toMatchObject({ status: "WAITING_FOR_RESPONSE", outboundMessageId: message.id });
    expect(reconciled.sentAt).toEqual(sentAt);
    expect(await a.db.conversationMessage.findUniqueOrThrow({ where: { id: message.id } }))
      .toMatchObject({ status: "SENT", direction: "OUTBOUND" });
    expect(await a.db.usageReservation.findUniqueOrThrow({ where: { sourceKey: admission.kind === "admitted" ? admission.admission.sourceKey : "" } }))
      .toMatchObject({ status: "COMMITTED", quantity: 1 });
    expect(a.providerRequests).toBe(0);
  }, 90_000);

  it.each(["lifetime-free", "paid-included", "purchased", "promotional"] as const)(
    "releases a resumed attempt from its exact %s reservation owner and replays idempotently",
    async (bucket) => {
      const a = f!;
      await a.service.enqueueInitial(a.recoveryId);
      const attempt = await a.db.recoveryOutreachAttempt.findUniqueOrThrow({
        where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: a.recoveryId, sequence: 1 } },
      });
      const sourceKey = createRecoveryIdempotencyKey(a.shopId, `recovery-outreach:${attempt.id}`);
      const subscription = await a.db.subscription.findUniqueOrThrow({ where: { shopId: a.shopId } });
      let counterId: string | undefined;
      let billingPeriodEntitlementCounterId: string | undefined;
      let purchasedCreditPurchaseId: string | undefined;
      let promotionalCreditGrantId: string | undefined;
      let checkReleased!: () => Promise<void>;

      if (bucket === "lifetime-free") {
        const counter = await a.db.shopEntitlementCounter.findUniqueOrThrow({
          where: { shopId_counter: { shopId: a.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
        });
        await a.db.shopEntitlementCounter.update({ where: { id: counter.id }, data: { reservedQuantity: 1 } });
        counterId = counter.id;
        checkReleased = async () => expect(await a.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: counter.id } }))
          .toMatchObject({ reservedQuantity: 0 });
      } else if (bucket === "paid-included") {
        const now = new Date();
        const period = await a.db.billingPeriod.create({ data: {
          shopId: a.shopId, subscriptionId: subscription.id, planId: subscription.planId,
          planKindSnapshot: "PAID_METERED", periodStart: new Date(now.getTime() - 60_000),
          periodEnd: new Date(now.getTime() + 60_000), status: "OPEN",
        } });
        billingPeriodEntitlementCounterId = (await a.db.billingPeriodEntitlementCounter.create({ data: {
          shopId: a.shopId, billingPeriodId: period.id, counter: "INCLUDED_RECOVERY_CREDITS",
          grantedQuantity: 1, reservedQuantity: 1,
        } })).id;
        checkReleased = async () => expect(await a.db.billingPeriodEntitlementCounter.findUniqueOrThrow({
          where: { id: billingPeriodEntitlementCounterId! },
        })).toMatchObject({ reservedQuantity: 0 });
      } else if (bucket === "purchased") {
        const counter = await a.db.shopEntitlementCounter.create({ data: {
          shopId: a.shopId, counter: "PURCHASED_RECOVERY_CREDITS", grantedQuantity: 1, reservedQuantity: 1,
        } });
        counterId = counter.id;
        const purchase = await a.db.recoveryCreditPurchase.create({ data: {
          id: randomUUID(), shopId: a.shopId, planId: subscription.planId!,
          provider: "WOOCOMMERCE", providerReference: `woo-pack-${attempt.id}`,
          providerPurchaseAmount: "1.00", providerPurchaseCurrency: "USD",
          providerValuationConfirmedAt: new Date(), providerPriceSnapshot: { amount: "1.00", currency: "USD" },
          creditsGranted: 1, currentAmount: 1, reservedAmount: 1,
          status: "ACTIVE", activatedAt: new Date(),
        } });
        purchasedCreditPurchaseId = purchase.id;
        checkReleased = async () => {
          expect(await a.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: purchase.id } }))
            .toMatchObject({ reservedAmount: 0 });
          expect(await a.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: counter.id } }))
            .toMatchObject({ reservedQuantity: 0 });
        };
      } else {
        const admin = await a.db.platformAdmin.create({ data: { email: `${a.shopId}@promotion.test` } });
        const now = new Date();
        const campaign = await a.db.promotionCampaign.create({ data: {
          name: `ARCH048-${a.shopId}`, scope: "GLOBAL", quantity: 1,
          startsAt: new Date(now.getTime() - 60_000), expiresAt: new Date(now.getTime() + 60_000),
          status: "ACTIVE", createdByPlatformAdminId: admin.id,
        } });
        const grant = await a.db.promotionalCreditGrant.create({ data: {
          shopId: a.shopId, campaignId: campaign.id, quantity: 1, reservedQuantity: 1,
        } });
        promotionalCreditGrantId = grant.id;
        checkReleased = async () => expect(await a.db.promotionalCreditGrant.findUniqueOrThrow({ where: { id: grant.id } }))
          .toMatchObject({ reservedQuantity: 0 });
      }

      const reservation = await a.db.usageReservation.create({ data: {
        shopId: a.shopId, sourceKey, quantity: 1, status: "RESERVED", counterId,
        billingPeriodEntitlementCounterId, purchasedCreditPurchaseId, promotionalCreditGrantId,
      } });
      await a.resumePreviousRecovery();
      await a.service.settleResumed(a.recoveryId);
      await a.service.settleResumed(a.recoveryId);
      expect(await a.db.usageReservation.findUniqueOrThrow({ where: { id: reservation.id } }))
        .toMatchObject({ status: "RELEASED", quantity: 1 });
      await checkReleased();
    },
  );

  it("keeps resumption settlement serialized while the Redis checkout lease renews past its original expiry", async () => {
    const a = f!;
    a.useRedisCheckoutCoordinator();
    await a.service.enqueueInitial(a.recoveryId);
    const attempt = await a.db.recoveryOutreachAttempt.findUniqueOrThrow({
      where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: a.recoveryId, sequence: 1 } },
    });
    const admission = await recoveryBillingService.admit({
      shopId: a.shopId, recoveryId: a.recoveryId, outreachAttemptId: attempt.id,
    });
    expect(admission.kind).toBe("admitted");

    let signalLeaseHeld!: () => void;
    let signalClosed!: () => void;
    const leaseHeld = new Promise<void>((resolve) => { signalLeaseHeld = resolve; });
    const closed = new Promise<void>((resolve) => { signalClosed = resolve; });
    const holder = a.coordinator.withCheckoutLock(
      { shopId: a.shopId, checkoutToken: a.checkoutToken }, async () => {
        signalLeaseHeld();
        // Woo's initial Redis lease is 10 seconds and its guard renews it every 3 seconds.
        await new Promise((resolve) => setTimeout(resolve, 10_500));
        await a.resumePreviousRecovery();
        signalClosed();
        await new Promise((resolve) => setTimeout(resolve, 750));
      },
    );
    await leaseHeld;
    await closed;
    let settlementFinished = false;
    const settlement = a.service.settleResumed(a.recoveryId).then(() => { settlementFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settlementFinished).toBe(false);
    await holder;
    await settlement;
    expect(settlementFinished).toBe(true);
    expect(await a.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))
      .toMatchObject({ status: "CANCELLED" });
    expect(await a.db.usageReservation.findUniqueOrThrow({ where: { sourceKey: admission.kind === "admitted" ? admission.admission.sourceKey : "" } }))
      .toMatchObject({ status: "RELEASED" });
  }, 90_000);

  it("retains credit and retries when attempt sentAt has no confirmed durable message", async () => {
    const a = f!;
    await a.service.enqueueInitial(a.recoveryId);
    const attempt = await a.db.recoveryOutreachAttempt.findUniqueOrThrow({
      where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: a.recoveryId, sequence: 1 } },
    });
    const billing = await recoveryBillingService.admit({
      shopId: a.shopId, recoveryId: a.recoveryId, outreachAttemptId: attempt.id,
    });
    expect(billing.kind).toBe("admitted");
    await a.db.recoveryOutreachAttempt.update({ where: { id: attempt.id }, data: { sentAt: new Date() } });
    await a.resumePreviousRecovery();

    await expect(a.service.settleResumed(a.recoveryId))
      .rejects.toThrow("WOO_INITIAL_PROVIDER_OUTCOME_UNCERTAIN");
    expect(await a.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))
      .toMatchObject({ status: "PENDING", outboundMessageId: null });
    expect(await a.db.usageReservation.findFirstOrThrow({ where: { shopId: a.shopId } }))
      .toMatchObject({ status: "RESERVED", quantity: 1 });
    expect(a.providerRequests).toBe(0);
  }, 90_000);

  it.each(["placed", "paid", "cancelled"] as const)(
    "releases the reserved credit when %s arrives after the last preflight but before provider permit",
    async (kind) => {
      const a = f!;
      await a.service.enqueueInitial(a.recoveryId);
      a.setBeforePermit(async () => { await a.setObservedOrder(kind); });
      await expect(a.service.processInitial(a.recoveryId)).resolves.toMatchObject({
        kind: "suppressed", reason: "final-send-denied",
      });
      expect(a.providerRequests).toBe(0);
      const attempts = await a.db.recoveryOutreachAttempt.findMany({ where: { checkoutRecoveryId: a.recoveryId } });
      expect(attempts).toHaveLength(1);
      // No provider permit was committed. Releasing the credit must not
      // terminally fail sequence one: only a definitive provider failure does.
      expect(attempts[0]).toMatchObject({
        sequence: 1, status: "PENDING", sentAt: null, outboundMessageId: null,
      });
      // The retained attempt is not permission to contact an ordered checkout.
      // Replaying the job must observe the terminal order and remain charge-free.
      await expect(a.service.processInitial(a.recoveryId)).resolves.toMatchObject({
        kind: "suppressed", reason: "observed-order-terminal",
      });
      expect(a.providerRequests).toBe(0);
      expect(await a.db.conversationMessage.count({ where: {
        conversation: { checkoutRecoveryId: a.recoveryId }, direction: "OUTBOUND",
      } })).toBe(0);
      const reservations = await a.db.usageReservation.findMany({ where: { shopId: a.shopId } });
      expect(reservations).toHaveLength(1);
      expect(reservations[0]!.status).toBe("RELEASED");
      const counter = await a.db.shopEntitlementCounter.findUniqueOrThrow({
        where: { shopId_counter: { shopId: a.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
      });
      expect(counter).toMatchObject({ committedQuantity: 0, reservedQuantity: 0 });
      expect(await a.db.usageEvent.count({ where: { shopId: a.shopId, metric: "RECOVERY_CONVERSATION" } })).toBe(0);
    }, 90_000,
  );

  it("rechecks authoritative local STOP after reservation and refunds without sending", async () => {
    const a = f!;
    await a.service.enqueueInitial(a.recoveryId);
    a.setBeforePermit(async () => { await a.stop(); });
    await expect(a.service.processInitial(a.recoveryId)).resolves.toMatchObject({
      kind: "suppressed", reason: "final-send-denied",
    });
    expect(a.providerRequests).toBe(0);
    expect((await a.db.customerPhone.findUniqueOrThrow({ where: { id: a.phoneId } })).whatsappNoContact)
      .toBe(true);
    expect(await a.db.usageReservation.findFirst({ where: { shopId: a.shopId } }))
      .toMatchObject({ status: "RELEASED" });
    expect(await a.db.usageEvent.count({ where: { shopId: a.shopId, metric: "RECOVERY_CONVERSATION" } })).toBe(0);
  }, 90_000);

  it("dispatches and settles eligible Woo initial outreach without a Woo-specific outbound flag", async () => {
    const a = f!;
    vi.stubEnv("MODA_WOO_TEST_OUTBOUND", undefined);
    try {
      // The fixture injects a disposable queue, database and controlled sender.
      expect(await a.service.enqueueInitial(a.recoveryId)).toMatchObject({ kind: "queued" });
      expect(await a.service.processInitial(a.recoveryId)).toMatchObject({ kind: "sent" });
      expect(await a.service.processInitial(a.recoveryId)).toMatchObject({ kind: "already-initialized" });
      expect(a.providerRequests).toBe(1);
      expect(await a.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: a.recoveryId } })).toBe(1);
      expect(await a.db.usageReservation.count({ where: { shopId: a.shopId, status: "COMMITTED" } })).toBe(1);
      expect(await a.db.usageEvent.count({ where: { shopId: a.shopId, metric: "RECOVERY_CONVERSATION" } })).toBe(1);
    } finally { vi.unstubAllEnvs(); }
  }, 90_000);
});
