import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecoveryBillingAdmission } from "../../../../src/services/recovery-billing.service.js";
import type { RecoveryPolicySnapshot } from "../../../../src/services/recovery-policy.service.js";
import type { WooRecoveryConsentSnapshot } from "../../../../src/services/woocommerce-recovery-consent.service.js";
import {
  WooRecoveryOutreachService,
  type WooInitialAttempt,
  type WooOutreachDependencies,
  type WooOutreachRecovery,
} from "../../../../src/services/woocommerce-recovery/woo-recovery-outreach.service.js";

const snapshot: WooRecoveryConsentSnapshot = {
  shopId: "woo-shop", installationId: "installation", credentialVersion: 1,
  customerId: "customer", customerPhoneId: "phone-id", canonicalRecipient: "447000111222",
  consentRevision: 3n, consentDecisionSequence: 3n, noContactRevision: 0n,
};
const policy = {
  recoveryDelayMinutes: 30, recoveryOfferMode: "NONE", fixedShopifyDiscountId: null,
  offerSnapshot: null, followUpEnabled: true, followUpDelayMinutes: 15,
  source: "MERCHANT",
} as RecoveryPolicySnapshot;
const template = {
  name: "woo_checkout_recovery", languageCode: "en_GB", canonicalLanguageTag: "en-GB",
  verifiedCategory: "MARKETING" as const,
};

function makeFixture() {
  let recovery: WooOutreachRecovery = {
    id: "recovery", shopId: "woo-shop", checkoutToken: "exact-checkout-key",
    customerId: "customer", status: "DETECTED", completedAt: null,
    shop: { platform: "WOOCOMMERCE", status: "ACTIVE" },
  };
  let attempt: WooInitialAttempt | null = null;
  let initialCreates = 0;
  let recipient = "+447000111222";
  let terminal: Awaited<ReturnType<WooOutreachDependencies["orders"]["read"]>> = { kind: "none-observed" };
  const messages = new Map<string, {
    id: string; status: string; conversationId: string; sentAt: Date | null; providerFailureCode?: string;
  }>();
  const logs: Array<{ level: string; event: string; data: Record<string, unknown> }> = [];
  let tail: Promise<unknown> = Promise.resolve();
  const admission = {
    kind: "purchased", sourceKey: "woo-reservation-1", policy: { shopId: "woo-shop" },
  } as RecoveryBillingAdmission;
  const release = vi.fn(async () => undefined);
  const compensate = vi.fn(async () => undefined);
  const committed = vi.fn(async () => undefined);
  const admit = vi.fn(async () => ({ kind: "admitted" as const, admission }));
  const revalidateBeforeProvider = vi.fn(async () => ({ kind: "admitted" as const, admission }));
  const enqueue = vi.fn(async () => undefined);
  const existing = vi.fn(async (key: string) => messages.get(key) ?? null);
  const send = vi.fn(async (input: { idempotencyKey: string }) => {
    messages.set(input.idempotencyKey, {
      id: "message", conversationId: "conversation", status: "SENT", sentAt: new Date("2026-10-24T01:00:00Z"),
    });
    return { kind: "admitted" as const };
  });
  const finalize = vi.fn(async () => {
    attempt = { ...attempt!, status: "WAITING_FOR_RESPONSE", sentAt: new Date("2026-10-24T01:00:00Z"),
      outboundMessageId: "message", followUpDueAt: null };
    recovery = { ...recovery, status: "MESSAGE_SENT" };
  });
  const markFailed = vi.fn(async () => {
    attempt = { ...attempt!, status: "FAILED" };
  });
  const consent = vi.fn(async (input: { expected?: WooRecoveryConsentSnapshot }) => ({
    status: "ALLOWED" as const, snapshot: input.expected ?? snapshot,
    customerPhoneId: snapshot.customerPhoneId, canonicalRecipient: snapshot.canonicalRecipient,
    consentRevision: snapshot.consentRevision, noContactRevision: snapshot.noContactRevision,
  }));
  const select = vi.fn(async () => ({ kind: "selected" as const, template }));
  const deps: WooOutreachDependencies = {
    logger: {
      child: () => ({
        info: (event: string, data: Record<string, unknown>) => logs.push({ level: "info", event, data }),
        warn: (event: string, data: Record<string, unknown>) => logs.push({ level: "warn", event, data }),
        error: (event: string, data: Record<string, unknown>) => logs.push({ level: "error", event, data }),
      }),
    } as unknown as WooOutreachDependencies["logger"],
    coordinator: {
      withCheckoutLock: async <T>(_ref: unknown, run: () => Promise<T>): Promise<T> => {
        // A fenced checkout lock: the factory never asserts that the old 10s
        // lease is sufficient. Even here provider admission is idempotent.
        const operation = tail.then(run, run);
        tail = operation.then(() => undefined, () => undefined);
        return operation;
      },
    },
    orders: { read: async () => terminal },
    recoveries: {
      get: async () => recovery,
      currentRecipient: async () => recipient,
    },
    attempts: {
      findInitial: async () => attempt,
      getOrCreateInitial: async ({ recipient: to }) => {
        if (!attempt) {
          initialCreates += 1;
          attempt = { id: "attempt-1", sequence: 1, status: "PENDING", recipient: to,
            sentAt: null, outboundMessageId: null, followUpDueAt: null };
        }
        return attempt;
      },
      markFailed,
    },
    consent: { evaluateStoredRecipient: consent } as unknown as WooOutreachDependencies["consent"],
    policies: { resolve: async () => policy },
    templates: { select },
    conversations: { getOrCreate: async () => ({ id: "conversation" }) },
    billing: {
      admit, revalidateBeforeProvider, releaseBeforeProvider: release,
      commitSuccessfulInitiation: committed,
    } as unknown as WooOutreachDependencies["billing"],
    providerFailure: { compensate },
    sender: { sendInitial: send as unknown as WooOutreachDependencies["sender"]["sendInitial"],
      findExistingAdmission: existing },
    finalize: { confirmed: finalize },
    enqueue: { initial: enqueue },
    enableTestOutbound: () => true,
  };
  return {
    service: new WooRecoveryOutreachService(deps), deps, logs, admission, send,
    admit, revalidateBeforeProvider, release, compensate, committed,
    finalize, consent, select, enqueue, existing, markFailed, messages,
    get attempt() { return attempt; },
    get initialCreates() { return initialCreates; },
    setRecipient(value: string) { recipient = value; },
    setRecovery(value: Partial<WooOutreachRecovery>) { recovery = { ...recovery, ...value }; },
    setTerminal(value: typeof terminal) { terminal = value; },
    setAttempt(value: WooInitialAttempt) { attempt = value; },
    disable() { deps.enableTestOutbound = undefined; },
  };
}

describe("ARCH-048-BACKGROUND-004 WooRecoveryOutreachService", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("keeps enqueue and dispatch default-off before any attempt, queue or credit", async () => {
    const f = makeFixture(); f.disable();
    expect(await f.service.enqueueInitial("recovery")).toEqual({ kind: "suppressed", reason: "woo-outbound-disabled" });
    expect(await f.service.processInitial("recovery")).toEqual({ kind: "suppressed", reason: "woo-outbound-disabled" });
    expect(f.initialCreates).toBe(0);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
  });

  it("cannot opt into outbound outside NODE_ENV=test", async () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const f = makeFixture();
      expect(await f.service.processInitial("recovery")).toEqual({ kind: "suppressed", reason: "woo-outbound-disabled" });
      expect(f.send).not.toHaveBeenCalled();
    } finally { process.env.NODE_ENV = previous; }
  });

  it("never routes a non-Woo recovery to the sender", async () => {
    const f = makeFixture(); f.setRecovery({ shop: { platform: "SHOPIFY", status: "ACTIVE" } });
    expect(await f.service.processInitial("recovery")).toEqual({ kind: "suppressed", reason: "woo-recovery-unavailable" });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("requeues the same committed initial attempt when BullMQ deleted the old job", async () => {
    const f = makeFixture();
    expect(await f.service.enqueueInitial("recovery")).toEqual({ kind: "queued", attemptId: "attempt-1" });
    expect(await f.service.enqueueInitial("recovery")).toEqual({ kind: "queued", attemptId: "attempt-1" });
    expect(f.initialCreates).toBe(1);
    expect(f.enqueue).toHaveBeenCalledTimes(2);
    expect(f.enqueue).toHaveBeenNthCalledWith(2, "recovery", "attempt-1");
    expect(f.admit).not.toHaveBeenCalled();
  });

  it("rethrows queue-publication failure and retries the existing attempt", async () => {
    const f = makeFixture();
    f.enqueue.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(f.service.enqueueInitial("recovery")).rejects.toThrow("redis unavailable");
    expect(f.initialCreates).toBe(1);
    expect(await f.service.enqueueInitial("recovery")).toMatchObject({ kind: "queued", attemptId: "attempt-1" });
    expect(f.initialCreates).toBe(1);
    expect(f.logs.find((x) => x.event === "woocommerce.recovery.outreach.failed")?.data.stage)
      .toBe("enqueue-initial");
  });

  it.each(["order-placed", "order-paid", "order-cancelled"] as const)(
    "suppresses observed %s before credits and Meta", async (kind) => {
      const f = makeFixture(); f.setTerminal({ kind, orderId: "order-1" });
      expect(await f.service.processInitial("recovery")).toEqual({ kind: "suppressed", reason: "observed-order-terminal" });
      expect(f.admit).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    },
  );

  it("defers ambiguous order evidence without assuming Woo is unpaid", async () => {
    const f = makeFixture(); f.setTerminal({ kind: "ambiguous", reason: "conflicting" });
    expect(await f.service.processInitial("recovery")).toEqual({ kind: "deferred", reason: "order-evidence-ambiguous" });
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(["NOT_AUTHORISED", "AMBIGUOUS"] as const)(
    "blocks current revoked/STOP/ambiguous Woo consent (%s)", async (status) => {
      const f = makeFixture();
      f.consent.mockResolvedValue({ status, reason: "LOCAL_NO_CONTACT" } as never);
      const result = await f.service.processInitial("recovery");
      expect(result.kind).toBe(status === "AMBIGUOUS" ? "deferred" : "suppressed");
      expect(f.admit).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    },
  );

  it("propagates stored-consent failures rather than acknowledging a deferred send", async () => {
    const f = makeFixture();
    f.consent.mockRejectedValueOnce(new Error("db timeout"));
    await expect(f.service.processInitial("recovery")).rejects.toThrow("db timeout");
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.logs.at(-1)?.level).toBe("error");
  });

  it("treats unavailable Woo stored consent as a retryable thrown failure", async () => {
    const f = makeFixture();
    f.consent.mockResolvedValueOnce({ status: "UNAVAILABLE", reason: "CONSENT_READ_FAILED" } as never);
    await expect(f.service.processInitial("recovery")).rejects.toThrow("WOO_CONSENT_READ_UNAVAILABLE");
    expect(f.admit).not.toHaveBeenCalled();
  });

  it("requires verified Marketing template before reserving credits", async () => {
    const f = makeFixture();
    f.select.mockResolvedValue({ kind: "unavailable", reason: "not-marketing" } as never);
    expect(await f.service.processInitial("recovery")).toEqual({ kind: "suppressed", reason: "marketing-template-unavailable" });
    expect(f.admit).not.toHaveBeenCalled();
  });

  it.each(["free", "paid", "lifetime-free", "purchased", "promotional"] as const)(
    "passes existing %s bucket/source attribution to guarded send and finalization", async (kind) => {
      const f = makeFixture();
      f.admission.kind = kind;
      const result = await f.service.processInitial("recovery");
      expect(result).toEqual({ kind: "sent", attemptId: "attempt-1" });
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.send).toHaveBeenCalledWith(expect.objectContaining({
        attemptId: "attempt-1", idempotencyKey: "recovery-outreach:attempt-1",
        recoveryCreditSourceKey: "woo-reservation-1", template: expect.objectContaining({ verifiedCategory: "MARKETING" }),
        consent: snapshot,
      }));
      expect(f.finalize).toHaveBeenCalledWith(expect.objectContaining({ admission: f.admission }));
      expect(await f.service.processInitial("recovery")).toEqual({ kind: "already-initialized", attemptId: "attempt-1" });
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.admit).toHaveBeenCalledTimes(1);
    },
  );

  it("prevents duplicate irreversible sends even under concurrent job replay", async () => {
    const f = makeFixture();
    const [a, b] = await Promise.all([f.service.processInitial("recovery"), f.service.processInitial("recovery")]);
    expect([a.kind, b.kind]).toEqual(["sent", "already-initialized"]);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.initialCreates).toBe(1);
  });

  it("reconciles a committed provider send even if order payment arrived afterwards", async () => {
    const f = makeFixture();
    f.setAttempt({ id: "attempt-1", sequence: 1, recipient: "+447000111222", status: "PENDING",
      sentAt: null, outboundMessageId: null, followUpDueAt: null });
    f.messages.set("recovery-outreach:attempt-1", {
      id: "message", status: "SENT", sentAt: new Date("2026-10-23T12:00:00Z"), conversationId: "conversation",
    });
    f.setTerminal({ kind: "order-paid", orderId: "order-1" });
    f.setRecovery({ status: "COMPLETED", completedAt: new Date("2026-10-24T01:00:00Z") });
    expect(await f.service.processInitial("recovery")).toEqual({ kind: "already-initialized", attemptId: "attempt-1" });
    expect(f.finalize).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it("blocks retries of a PENDING durable provider message instead of a second Meta request", async () => {
    const f = makeFixture();
    f.setAttempt({ id: "attempt-1", sequence: 1, recipient: "+447000111222", status: "PENDING",
      sentAt: null, outboundMessageId: null, followUpDueAt: null });
    f.messages.set("recovery-outreach:attempt-1", {
      id: "message", status: "PENDING", sentAt: null, conversationId: "conversation",
    });
    await expect(f.service.processInitial("recovery")).rejects.toThrow("WOO_INITIAL_PROVIDER_OUTCOME_UNCERTAIN");
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("releases a rejected pre-permit send and terminalises its attempt", async () => {
    const f = makeFixture();
    f.send.mockResolvedValue({ kind: "suppressed", reason: "conversation-invalid" } as never);
    expect(await f.service.processInitial("recovery")).toEqual({ kind: "suppressed", reason: "final-send-denied" });
    expect(f.release).toHaveBeenCalledWith(f.admission);
    expect(f.markFailed).toHaveBeenCalledWith("attempt-1", "FINAL_SEND_DENIED");
    expect(f.finalize).not.toHaveBeenCalled();
  });

  it("reconciles duplicate admission with durable SENT evidence instead of another send", async () => {
    const f = makeFixture();
    f.send.mockImplementationOnce(async () => {
      f.messages.set("recovery-outreach:attempt-1", { id: "message", conversationId: "conversation",
        status: "SENT", sentAt: new Date() });
      return { kind: "suppressed", reason: "duplicate" } as never;
    });
    expect(await f.service.processInitial("recovery")).toEqual({ kind: "already-initialized", attemptId: "attempt-1" });
    expect(f.finalize).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
  });

  it("keeps an unknown provider timeout visible and never blindly retries", async () => {
    const f = makeFixture();
    f.send.mockImplementationOnce(async () => {
      f.messages.set("recovery-outreach:attempt-1", { id: "message", conversationId: "conversation",
        status: "PENDING", sentAt: null });
      throw new Error("provider timeout containing +447000111222");
    });
    await expect(f.service.processInitial("recovery")).rejects.toThrow("provider timeout");
    expect(f.compensate).toHaveBeenCalledWith(f.admission, expect.any(Error));
    await expect(f.service.processInitial("recovery")).rejects.toThrow("WOO_INITIAL_PROVIDER_OUTCOME_UNCERTAIN");
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.logs)).not.toContain("+447000111222");
    expect(JSON.stringify(f.logs)).not.toContain("provider timeout containing");
  });

  it("does not compensate a provider-confirmed send even when a sender exception surfaces", async () => {
    const f = makeFixture();
    f.send.mockImplementationOnce(async () => {
      f.messages.set("recovery-outreach:attempt-1", { id: "message", conversationId: "conversation",
        status: "SENT", sentAt: new Date() });
      throw new Error("provider returned after durable persistence");
    });
    await expect(f.service.processInitial("recovery")).rejects.toThrow("provider returned after");
    expect(f.compensate).not.toHaveBeenCalled();
    expect(await f.service.processInitial("recovery")).toMatchObject({ kind: "already-initialized" });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("surfaces simultaneous provider and compensation faults, retaining original cause", async () => {
    const f = makeFixture();
    const providerFailure = new Error("provider failed");
    const compensationFailure = new Error("compensation failed");
    f.send.mockRejectedValueOnce(providerFailure);
    f.compensate.mockRejectedValueOnce(compensationFailure);
    const failure = await f.service.processInitial("recovery").then(
      () => { throw new Error("expected provider compensation to fail"); },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe("WOO_PROVIDER_COMPENSATION_FAILED");
    expect((failure as AggregateError).cause).toBe(providerFailure);
    expect((failure as AggregateError).errors).toEqual([providerFailure, compensationFailure]);
    expect(f.finalize).not.toHaveBeenCalled();
  });

  it.each(["admit", "revalidateBeforeProvider"] as const)(
    "throws and logs unexpected %s failures instead of success", async (method) => {
      const f = makeFixture();
      f[method].mockRejectedValueOnce(new Error("credit attribution unavailable"));
      await expect(f.service.processInitial("recovery")).rejects.toThrow("credit attribution unavailable");
      expect(f.send).not.toHaveBeenCalled();
      expect(f.logs.at(-1)?.event).toBe("woocommerce.recovery.outreach.failed");
    },
  );

  it("surfaces preflight and release failures together, without sending", async () => {
    const f = makeFixture();
    const preflightFailure = new Error("revocation reader outage");
    const releaseFailure = new Error("release outage");
    // The guard runs twice, so the failure must occur after the first grant.
    f.consent.mockResolvedValueOnce({ status: "ALLOWED", snapshot,
      customerPhoneId: snapshot.customerPhoneId, canonicalRecipient: snapshot.canonicalRecipient,
      consentRevision: 3n, noContactRevision: 0n });
    f.consent.mockRejectedValueOnce(preflightFailure);
    f.release.mockRejectedValueOnce(releaseFailure);
    const failure = await f.service.processInitial("recovery").then(
      () => { throw new Error("expected pre-send release to fail"); },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe("WOO_PRE_SEND_RELEASE_FAILED");
    expect((failure as AggregateError).cause).toBe(preflightFailure);
    expect((failure as AggregateError).errors).toEqual([preflightFailure, releaseFailure]);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("releases credits if STOP changes during the final preflight", async () => {
    const f = makeFixture();
    f.consent.mockResolvedValueOnce({ status: "ALLOWED", snapshot,
      customerPhoneId: snapshot.customerPhoneId, canonicalRecipient: snapshot.canonicalRecipient,
      consentRevision: 3n, noContactRevision: 0n });
    f.consent.mockResolvedValueOnce({ status: "NOT_AUTHORISED", reason: "LOCAL_NO_CONTACT" } as never);
    expect(await f.service.processInitial("recovery")).toEqual({ kind: "suppressed", reason: "woo-consent-not-authorised" });
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("retries confirmed finalization without a new Meta send or refund", async () => {
    const f = makeFixture();
    f.finalize.mockRejectedValueOnce(new Error("db finalization conflict"));
    await expect(f.service.processInitial("recovery")).rejects.toThrow("db finalization conflict");
    expect(f.compensate).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(await f.service.processInitial("recovery")).toEqual({ kind: "already-initialized", attemptId: "attempt-1" });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.finalize).toHaveBeenCalledTimes(2);
  });


  it("requeues confirmed-but-not-finalized delivery even when new outbound is disabled", async () => {
    const f = makeFixture(); f.disable();
    f.setAttempt({ id: "attempt-1", sequence: 1, recipient: "+447000111222", status: "PENDING",
      sentAt: null, outboundMessageId: null, followUpDueAt: null });
    f.messages.set("recovery-outreach:attempt-1", {
      id: "message", status: "SENT", sentAt: new Date(), conversationId: "conversation",
    });
    expect(await f.service.enqueueInitial("recovery")).toEqual({ kind: "queued", attemptId: "attempt-1" });
    expect(await f.service.processInitial("recovery")).toEqual({ kind: "already-initialized", attemptId: "attempt-1" });
    expect(f.enqueue).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("requeues sent attempt when the recovery row was not yet finalised", async () => {
    const f = makeFixture(); f.disable();
    f.setAttempt({ id: "attempt-1", sequence: 1, recipient: "+447000111222",
      status: "WAITING_FOR_RESPONSE", sentAt: new Date(), outboundMessageId: "message",
      followUpDueAt: null });
    f.messages.set("recovery-outreach:attempt-1", {
      id: "message", status: "SENT", sentAt: new Date(), conversationId: "conversation",
    });
    expect(await f.service.enqueueInitial("recovery")).toEqual({ kind: "queued", attemptId: "attempt-1" });
    expect(await f.service.processInitial("recovery")).toEqual({ kind: "already-initialized", attemptId: "attempt-1" });
    expect(f.finalize).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("fails visibly when a failed provider message was not durably compensated", async () => {
    const f = makeFixture();
    f.setAttempt({ id: "attempt-1", sequence: 1, recipient: "+447000111222",
      status: "PENDING", sentAt: null, outboundMessageId: null, followUpDueAt: null });
    f.messages.set("recovery-outreach:attempt-1", {
      id: "message", status: "FAILED", sentAt: null, conversationId: "conversation",
    });
    await expect(f.service.processInitial("recovery")).rejects.toThrow("WOO_INITIAL_PROVIDER_FAILURE_UNRECONCILED");
    await expect(f.service.enqueueInitial("recovery")).rejects.toThrow("WOO_INITIAL_PROVIDER_FAILURE_UNRECONCILED");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it("blocks enqueue when a previous provider permit is unresolved", async () => {
    const f = makeFixture();
    f.setAttempt({ id: "attempt-1", sequence: 1, recipient: "+447000111222", status: "PENDING",
      sentAt: null, outboundMessageId: null, followUpDueAt: null });
    f.messages.set("recovery-outreach:attempt-1", {
      id: "message", status: "PENDING", sentAt: null, conversationId: "conversation",
    });
    await expect(f.service.enqueueInitial("recovery")).rejects.toThrow("WOO_INITIAL_PROVIDER_OUTCOME_UNCERTAIN");
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("rechecks observed terminal order evidence AFTER reserving credit", async () => {
    const f = makeFixture();
    f.admit.mockImplementationOnce(async () => {
      f.setTerminal({ kind: "order-placed", orderId: "order-during-reservation" });
      return { kind: "admitted" as const, admission: f.admission };
    });
    expect(await f.service.processInitial("recovery")).toEqual({ kind: "suppressed", reason: "observed-order-terminal" });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("compensates a template category change after initial credit admission", async () => {
    const f = makeFixture();
    f.select.mockResolvedValueOnce({ kind: "selected", template });
    f.select.mockResolvedValueOnce({ kind: "unavailable", reason: "category-revoked" } as never);
    expect(await f.service.processInitial("recovery")).toEqual({ kind: "suppressed", reason: "marketing-template-changed" });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("never authorises a Woo follow-up when a historic initial attempt has a due date", async () => {
    const f = makeFixture();
    f.setAttempt({ id: "attempt-1", sequence: 1, recipient: "+447000111222", status: "PENDING",
      sentAt: null, outboundMessageId: null, followUpDueAt: new Date() });
    await expect(f.service.processInitial("recovery")).rejects.toThrow("WOO_INITIAL_ATTEMPT_CONFLICT");
    expect(f.send).not.toHaveBeenCalled();
  });
});
