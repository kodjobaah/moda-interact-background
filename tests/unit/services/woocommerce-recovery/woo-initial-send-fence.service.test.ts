import { describe, expect, it, vi } from "vitest";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { WooInitialSendFenceService } from "../../../../src/services/woocommerce-recovery/woo-initial-send-fence.service.js";

const attemptId = "attempt-1";
const key = `recovery-outreach:${attemptId}`;
const now = new Date("2026-10-31T12:00:00.000Z");
const scope = {
  shopId: "shop-1", recoveryId: "recovery-1", checkoutToken: "checkout-1", customerId: "customer-1",
  conversationId: "conversation-1", attemptId, messageId: "message-1",
  recipient: "+447400123456", idempotencyKey: key,
  recoveryCreditSourceKey: createRecoveryIdempotencyKey("shop-1", key),
  templateName: "woo_recovery", languageCode: "en_GB", verifiedCategory: "MARKETING" as const,
  expectedContent: "[moderated-template]",
  templateRegistration: {
    shopId: "shop-1", senderWabaId: "waba-1", purpose: "INITIAL_NO_OFFER" as const,
    variantId: "variant-1", registrationId: "registration-1", definitionId: "definition-1",
    providerTemplateId: "provider-1", providerTemplateName: "woo_recovery",
    providerLanguageCode: "en_GB", submittedContentHash: "a".repeat(64),
    bindingFingerprint: "a".repeat(64),
  },
  consent: { shopId: "shop-1", installationId: "install-1", credentialVersion: 1,
    customerId: "customer-1", customerPhoneId: "phone-1", canonicalRecipient: "447400123456",
    consentRevision: 1n, consentDecisionSequence: 1n, noContactRevision: 0n },
};

function harness() {
  const queries: string[] = [];
  const outcomes: Record<string, unknown[]> = {
    'FROM "commerce"."Shop"': [{ status: "ACTIVE", platform: "WOOCOMMERCE" }],
    'FROM "whatsapp"."Conversation"': [{ shopId: "shop-1", checkoutRecoveryId: "recovery-1",
      type: "RECOVERY", controlMode: "AI", controlRevision: 0 }],
    'FROM "commerce"."CheckoutRecovery"': [{ shopId: "shop-1", checkoutToken: "checkout-1",
      customerId: "customer-1", status: "DETECTED", completedAt: null, expiredAt: null,
      lastExternalActivityAt: new Date(now.getTime() - 60_000) }],
    'FROM public."BackgroundRuntimeConfig"': [{ checkoutRecoveryLifetimeDays: 21 }],
    'FROM "commerce"."CheckoutRecoveryStatusHistory"': [],
    'FROM "commerce"."RecoveryOutreachAttempt"': [{ checkoutRecoveryId: "recovery-1",
      sequence: 1, status: "PENDING", recipient: "+447400123456", sentAt: null,
      outboundMessageId: null, followUpDueAt: null }],
    'FROM "commerce"."CustomerPhone"': [{ id: "phone-1", phone: "+447400123456",
      whatsappCanonicalPhone: "447400123456", defaultCountryCode: "GB" }],
    'FROM "billing"."UsageReservation"': [{ shopId: "shop-1", quantity: 1, status: "RESERVED" }],
    'FROM "billing"."UsageEvent"': [{ sourceId: "message-1", shopId: "shop-1",
      metric: "OUTBOUND_AUTOMATED_MESSAGE" }],
    'FROM "whatsapp"."ConversationMessage"': [{ status: "PENDING", content: scope.expectedContent,
      providerDispatchKey: null, providerDispatchAdmittedAt: null }],
    'UPDATE "whatsapp"."ConversationMessage"': [{ id: "message-1" }],
  };
  const queryRaw = vi.fn(async (sql: string) => {
    queries.push(sql);
    // The locked message lookup and the independent unique dispatch-key
    // lookup read the same table but must have different fixture outcomes.
    if (sql.includes('WHERE "providerDispatchKey"=$1 LIMIT 1')) {
      return outcomes["prior-provider-dispatch-key"] ?? [];
    }
    return Object.entries(outcomes).find(([pattern]) => sql.includes(pattern))?.[1] ?? [];
  });
  const tx = { $queryRawUnsafe: queryRaw, $executeRawUnsafe: vi.fn() };
  const transaction = vi.fn(async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx));
  const confirm = vi.fn(async () => true);
  const noContact = vi.fn(async () => false);
  const logger = { warn: vi.fn(), error: vi.fn(), child() { return this; } };
  const checkTemplate = vi.fn(async () => null as string | null);
  const fence = new WooInitialSendFenceService({ $transaction: transaction } as never,
    confirm as never, noContact as never, logger as never, checkTemplate as never, () => now);
  return { fence, outcomes, queries, transaction, confirm, noContact, logger, checkTemplate };
}

describe("ARCH-046-BACKGROUND-004 final Woo SQL permit", () => {
  it("locks Shop before conversation/attempt/message, checks consent/STOP and commits exactly one permit", async () => {
    const f = harness();
    expect(await f.fence.admitFinalSend(scope)).toEqual({ kind: "admitted" });
    expect(f.queries[0]).toContain('"Shop"');
    expect(f.queries[0]).toContain("FOR UPDATE");
    expect(f.queries.findIndex((s) => s.includes('"Shop"')))
      .toBeLessThan(f.queries.findIndex((s) => s.includes('"RecoveryOutreachAttempt"')));
    expect(f.queries.findIndex((s) => s.includes('BackgroundRuntimeConfig')))
      .toBeGreaterThan(f.queries.findIndex((s) => s.includes('"ConversationMessage"') && s.includes("FOR UPDATE")));
    expect(f.queries.find((s) => s.includes("BackgroundRuntimeConfig"))).toContain("FOR SHARE");
    expect(f.confirm).toHaveBeenCalledWith(expect.anything(), "shop-1", scope.consent, undefined);
    expect(f.noContact).toHaveBeenCalledWith(expect.anything(), {
      shopId: "shop-1", recipient: scope.recipient,
    });
    expect(f.queries.at(-1)).toContain('SET "providerDispatchKey"');
  });

  it.each([
    ["inactive shop", 'FROM "commerce"."Shop"', [{ status: "SUSPENDED", platform: "WOOCOMMERCE" }]],
    ["other conversation", 'FROM "whatsapp"."Conversation"', [{ shopId: "other", checkoutRecoveryId: "recovery-1", type: "RECOVERY", controlMode: "AI" }]],
    ["terminal recovery", 'FROM "commerce"."CheckoutRecovery"', [{ shopId: "shop-1", checkoutToken: "checkout-1", customerId: "customer-1", status: "COMPLETED" }]],
    ["recorded order", 'FROM "commerce"."CheckoutRecoveryStatusHistory"', [{ id: "history" }]],
    ["used initial attempt", 'FROM "commerce"."RecoveryOutreachAttempt"', [{ checkoutRecoveryId: "recovery-1", sequence: 1, status: "WAITING_FOR_RESPONSE", recipient: "+447400123456" }]],
    ["ambiguous recipient", 'FROM "commerce"."CustomerPhone"', [
      { id: "phone-1", phone: "+447400123456", whatsappCanonicalPhone: "447400123456", defaultCountryCode: "GB" },
      { id: "phone-2", phone: "+447400123456", whatsappCanonicalPhone: "447400123456", defaultCountryCode: "GB" },
    ]],
    ["wrong billing source", 'FROM "billing"."UsageEvent"', [{ sourceId: "other", shopId: "shop-1", metric: "OUTBOUND_AUTOMATED_MESSAGE" }]],
  ])("suppresses %s before inserting a provider dispatch key", async (_, statement, result) => {
    const f = harness(); f.outcomes[statement] = result;
    expect((await f.fence.admitFinalSend(scope)).kind).toBe("suppressed");
    expect(f.queries.some((s) => s.includes('SET "providerDispatchKey"'))).toBe(false);
  });

  it("rejects changed consent revision and any local STOP", async () => {
    const f = harness(); f.confirm.mockResolvedValueOnce(false);
    expect(await f.fence.admitFinalSend(scope)).toEqual({ kind: "suppressed", reason: "woo-consent-changed" });
    const g = harness(); g.noContact.mockResolvedValueOnce(true);
    expect(await g.fence.admitFinalSend(scope)).toEqual({ kind: "suppressed", reason: "woo-local-no-contact" });
  });

  it("denies the exact inactivity cutoff and admits one millisecond before it", async () => {
    const exact = harness();
    exact.outcomes['FROM "commerce"."CheckoutRecovery"'] = [{ shopId: "shop-1",
      checkoutToken: "checkout-1", customerId: "customer-1", status: "DETECTED",
      completedAt: null, expiredAt: null, lastExternalActivityAt: new Date(now.getTime() - 21 * 86_400_000) }];
    expect(await exact.fence.admitFinalSend(scope))
      .toEqual({ kind: "suppressed", reason: "woo-recovery-lifetime-elapsed" });
    expect(exact.queries.some((sql) => sql.includes('SET "providerDispatchKey"'))).toBe(false);

    const recent = harness();
    recent.outcomes['FROM "commerce"."CheckoutRecovery"'] = [{ shopId: "shop-1",
      checkoutToken: "checkout-1", customerId: "customer-1", status: "DETECTED",
      completedAt: null, expiredAt: null, lastExternalActivityAt: new Date(now.getTime() - 21 * 86_400_000 + 1) }];
    expect(await recent.fence.admitFinalSend(scope)).toEqual({ kind: "admitted" });

    const future = harness();
    future.outcomes['FROM "commerce"."CheckoutRecovery"'] = [{ shopId: "shop-1",
      checkoutToken: "checkout-1", customerId: "customer-1", status: "DETECTED",
      completedAt: null, expiredAt: null, lastExternalActivityAt: new Date(now.getTime() + 1) }];
    expect(await future.fence.admitFinalSend(scope))
      .toEqual({ kind: "suppressed", reason: "woo-recovery-lifetime-elapsed" });
  });

  it("fails closed and warns when the locked persisted policy is missing or invalid", async () => {
    for (const policy of [[], [{ checkoutRecoveryLifetimeDays: -1 }]]) {
      const f = harness();
      f.outcomes['FROM public."BackgroundRuntimeConfig"'] = policy;
      expect(await f.fence.admitFinalSend(scope))
        .toEqual({ kind: "suppressed", reason: "checkout-lifetime-policy-unavailable" });
      expect(f.queries.some((sql) => sql.includes('SET "providerDispatchKey"'))).toBe(false);
      expect(f.logger.warn).toHaveBeenCalledWith(
        "woocommerce.recovery.initial.lifetime_policy.unavailable",
        expect.objectContaining({ shopId: "shop-1", recoveryId: "recovery-1" }));
    }
  });

  it.each(["TEMPLATE_REGISTRATION_UNAVAILABLE", "TEMPLATE_PROVIDER_STATUS_UNRESOLVED",
    "TEMPLATE_PROVIDER_STATUS_STALE"])(
    "denies %s returned by the shared exact-registration SQL fence", async (reason) => {
      const f = harness();
      f.checkTemplate.mockResolvedValueOnce(reason);
      expect(await f.fence.admitFinalSend(scope)).toEqual({ kind: "suppressed", reason });
      expect(f.checkTemplate).toHaveBeenCalledWith(expect.anything(), scope.templateRegistration, expect.any(Date));
      expect(f.queries.some((sql) => sql.includes('SET "providerDispatchKey"'))).toBe(false);
    },
  );

  it("suppresses existing provider permit and cannot overwrite prepared content", async () => {
    const f = harness();
    f.outcomes['FROM "whatsapp"."ConversationMessage"'] = [{ status: "PENDING",
      content: scope.expectedContent, providerDispatchKey: "existing", providerDispatchAdmittedAt: new Date() }];
    expect(await f.fence.admitFinalSend(scope)).toEqual({ kind: "suppressed", reason: "already-admitted-or-sent" });
    const g = harness();
    g.outcomes['FROM "whatsapp"."ConversationMessage"'] = [{ status: "PENDING",
      content: "tampered", providerDispatchKey: null, providerDispatchAdmittedAt: null }];
    expect((await g.fence.admitFinalSend(scope)).kind).toBe("suppressed");
  });

  it("suppresses a different message already holding the durable attempt dispatch key", async () => {
    const f = harness();
    f.outcomes["prior-provider-dispatch-key"] = [{ id: "previous-message" }];
    expect(await f.fence.admitFinalSend(scope))
      .toEqual({ kind: "suppressed", reason: "already-admitted-or-sent" });
    expect(f.queries.some((sql) => sql.includes('SET "providerDispatchKey"'))).toBe(false);
  });

  it("rejects other shop/attempt billing identity without opening a transaction", async () => {
    const f = harness();
    expect((await f.fence.admitFinalSend({ ...scope, recoveryCreditSourceKey: "wrong" })).kind)
      .toBe("suppressed");
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("propagates DB faults without returning customer refusal", async () => {
    const f = harness();
    const failure = Object.assign(new Error("connection unavailable"), { code: "P1001" });
    f.transaction.mockRejectedValueOnce(failure);
    await expect(f.fence.admitFinalSend(scope)).rejects.toBe(failure);
    expect(f.logger.error).toHaveBeenCalledWith("woocommerce.recovery.initial.sql_permit.failed", {
      shopId: "shop-1", recoveryId: "recovery-1", attemptId: "attempt-1",
      errorName: "Error", errorCode: "P1001", error: failure,
    });
  });
});
