import { afterAll, describe, expect, it } from "vitest";
import { connect, enabled, seed } from "./fixtures/initial-outreach-admission.fixture.js";

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
});
