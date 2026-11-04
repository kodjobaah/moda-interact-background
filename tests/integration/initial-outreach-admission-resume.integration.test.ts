import { afterAll, describe, expect, it } from "vitest";
import { barrier, connect, enabled, seed, seedShopify } from "./fixtures/initial-outreach-admission.fixture.js";

describe.runIf(enabled)("initial outreach durable resume", () => {
  const a = connect();
  const b = connect();
  afterAll(async () => { await Promise.all([a.$disconnect(), b.$disconnect()]); });

  it("two real Woo senders share one message, usage, credit and provider permit", async () => {
    const fixture = await seed(a);
    const { input, scope } = fixture;
    const outcomes = await Promise.allSettled([
      fixture.sender(a).sendInitial(fixture.sendInput),
      fixture.sender(b).sendInitial(fixture.sendInput),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled" && result.value.kind === "admitted"))
      .toHaveLength(1);
    expect(fixture.requests).toHaveBeenCalledTimes(1);
    const message = await b.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } });
    expect(message.status).toBe("SENT");
    expect(message.providerDispatchKey).toMatch(/^arch046-woo-initial-/);
    const conversation = await b.conversation.findUniqueOrThrow({ where: { id: input.conversationId } });
    expect(conversation.lastMessageAt).toEqual(message.sentAt);
    expect(await b.conversationMessage.count({ where: { conversationId: input.conversationId } })).toBe(1);
    expect(await b.usageEvent.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(1);
    expect(await b.usageReservation.count({ where: { shopId: input.shopId } })).toBe(1);
    expect((await fixture.service(b).inspectInitialOutreachAdmission(scope)).kind).toBe("confirmed");
  }, 45_000);

  it("holds inconsistent PENDING receipts without provider calls", async () => {
    const fixture = await seed(a);
    const { input, scope } = fixture;
    for (const data of [
      { deliveredAt: new Date() },
      { deliveredAt: null, readAt: new Date() },
      { readAt: null, failedAt: new Date() },
    ]) {
      await a.conversationMessage.update({ where: { id: input.messageId }, data });
      await expect(fixture.service(a).inspectInitialOutreachAdmission(scope)).resolves.toEqual({
        kind: "held", reason: "provider-outcome-unknown",
      });
      await expect(fixture.sender(a).sendInitial(fixture.sendInput)).rejects.toThrow("UNCERTAIN");
    }
    expect(fixture.requests).not.toHaveBeenCalled();
    expect(await a.usageEvent.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(1);
  }, 45_000);

  it("retains the exact initial attempt link on a known pre-permit refusal", async () => {
    const fixture = await seed(a);
    const { input, scope } = fixture;
    await fixture.service(a).failPrepared(input.messageId);
    await fixture.service(b).failPrepared(input.messageId);
    expect(await b.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: input.attemptId } }))
      .toMatchObject({ status: "FAILED", failureCode: "PRE_PROVIDER_REFUSED", outboundMessageId: input.messageId });
    expect(await b.usageEvent.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(0);
    expect(await fixture.service(b).inspectInitialOutreachAdmission(scope))
      .toMatchObject({ kind: "failed", disposition: "pre-permit-refused", message: { id: input.messageId } });
    expect(fixture.requests).not.toHaveBeenCalled();
  }, 45_000);

  it("Shopify resumes one original message while another worker observes its committed permit", async () => {
    const fixture = await seedShopify(a);
    const providerEntered = barrier();
    const providerReturns = barrier();
    fixture.requests.mockImplementationOnce(async () => {
      providerEntered.release();
      await providerReturns.wait;
      return { providerMessageId: `wamid-${fixture.input.messageId}` };
    });
    const first = fixture.service(a).resumeInitialTemplate(fixture.resume);
    try {
      await Promise.race([providerEntered.wait, first.then((result) => {
        throw new Error(`Shopify did not reach provider: ${JSON.stringify(result)}`);
      })]);
      const pending = await b.conversationMessage.findUniqueOrThrow({ where: { id: fixture.input.messageId } });
      expect(pending).toMatchObject({ status: "PENDING", providerDispatchKey: expect.stringMatching(/^arch040-auto-/) });
      expect(await fixture.service(b).resumeInitialTemplate(fixture.resume)).toEqual({ kind: "suppressed", reason: "duplicate" });
    } finally {
      providerReturns.release();
      await Promise.allSettled([first]);
    }
    expect(await first).toMatchObject({ kind: "admitted", messageId: fixture.input.messageId });
    expect(fixture.requests).toHaveBeenCalledTimes(1);
    expect(await b.usageEvent.count({ where: { idempotencyKey: fixture.input.idempotencyKey } })).toBe(1);
    expect(await b.usageReservation.count({ where: { shopId: fixture.input.shopId } })).toBe(1);
    expect(await b.conversationMessage.count({ where: { conversationId: fixture.input.conversationId } })).toBe(1);
  }, 45_000);

  it("holds a legacy failed attempt and rejects ambiguous historical paid credit", async () => {
    const fixture = await seedShopify(a);
    const { input } = fixture;
    const subscription = await a.subscription.create({ data: { shopId: input.shopId, status: "ACTIVE" } });
    const period = await a.billingPeriod.create({ data: {
      shopId: input.shopId, subscriptionId: subscription.id, periodStart: new Date(Date.now() - 7200000),
      periodEnd: new Date(Date.now() - 3600000), status: "CLOSED", closedAt: new Date(),
    } });
    const counter = await a.billingPeriodEntitlementCounter.create({ data: {
      shopId: input.shopId, billingPeriodId: period.id, counter: "INCLUDED_RECOVERY_CREDITS", grantedQuantity: 1,
    } });
    const paid = await a.usageReservation.create({ data: {
      shopId: input.shopId, sourceKey: `paid-included:${period.id}:${input.recoveryCreditSourceKey}`,
      billingPeriodEntitlementCounterId: counter.id, quantity: 1, status: "RELEASED",
    } });
    await expect(fixture.service(a).resumeInitialTemplate(fixture.resume)).resolves.toMatchObject({ kind: "suppressed" });
    expect(fixture.requests).not.toHaveBeenCalled();
    expect(await a.usageReservation.count({ where: { shopId: input.shopId } })).toBe(2);
    expect(await a.usageReservation.findUniqueOrThrow({ where: { id: paid.id } })).toMatchObject({ status: "RELEASED" });
    const legacy = await seedShopify(a);
    await a.usageEvent.delete({ where: { idempotencyKey: legacy.input.idempotencyKey } });
    await a.conversationMessage.delete({ where: { id: legacy.input.messageId } });
    await a.recoveryOutreachAttempt.update({
      where: { id: legacy.input.attemptId }, data: { status: "FAILED" },
    });
    await expect(legacy.service(a).inspectInitialOutreachAdmission(legacy.scope)).resolves.toEqual({
      kind: "held", reason: "lineage-conflict",
    });
  }, 45_000);

  it("rejects promotional credit when its selected owner is removed", async () => {
    const fixture = await seed(a);
    const { input } = fixture;
    const admin = await a.platformAdmin.create({ data: { email: `${input.shopId}@example.test` } });
    const campaign = await a.promotionCampaign.create({ data: {
      name: "fixture campaign", scope: "GLOBAL", quantity: 1,
      startsAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() + 60000),
      status: "ACTIVE", createdByPlatformAdminId: admin.id,
    } });
    const grant = await a.promotionalCreditGrant.create({ data: {
      shopId: input.shopId, campaignId: campaign.id, quantity: 1, reservedQuantity: 1,
    } });
    await a.usageReservation.update({
      where: { sourceKey: input.recoveryCreditSourceKey },
      data: { counterId: null, promotionalCreditGrantId: grant.id },
    });
    await a.merchantPromotionSelection.create({ data: {
      shopId: input.shopId, promotionalCreditGrantId: grant.id,
    } });
    await b.merchantPromotionSelection.delete({ where: { shopId: input.shopId } });
    await expect(fixture.sender(a).sendInitial(fixture.sendInput)).resolves.toMatchObject({ kind: "suppressed" });
    expect(fixture.requests).not.toHaveBeenCalled();
    expect(await a.usageReservation.findUniqueOrThrow({ where: { sourceKey: input.recoveryCreditSourceKey } }))
      .toMatchObject({ status: "RESERVED", promotionalCreditGrantId: grant.id });
    expect(await a.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } }))
      .toMatchObject({ providerDispatchKey: null });
  }, 45_000);
});
