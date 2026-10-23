import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/redis.js", () => ({ connectionRedis: { eval: vi.fn() } }));
vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));

import { HumanCommandDispatcherService, type HumanDispatcherDependencies } from
  "../../../../src/services/recovery-conversation/human-command-dispatcher.service.js";

const error = Object.assign(new Error("provider rejected"), {
  name: "WhatsAppServiceError", code: "provider-rejected", providerCode: "131026",
});

function fixture(kind: "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE") {
  const command = {
    id: "cmd-1", shopId: "shop-1", conversationId: "conv-1",
    idempotencyKey: "send-1", kind, expectedControlRevision: 2,
    recipientSnapshot: "447700900001", textBody: "Hello", templateName: "follow_up",
    templateLanguageCode: "en", templateParameters: [],
    recoveryOutreachAttemptId: "attempt-1",
  };
  const admission = { kind: "free", sourceKey: "recovery-outreach:attempt-1" };
  const events: string[] = [];
  const reconciliation = { recordDefinitiveFailure: vi.fn(async (input: { reason: string }) => {
    events.push("persisted:" + input.reason);
    return { kind: "definitive-failure", messageId: "message-1" } as const;
  }), recordProviderUnknown: vi.fn() };
  const billing = { admitAndRevalidate: vi.fn(async () => ({ kind: "admitted", admission })),
    onDefinitiveProviderFailure: vi.fn(async () => { events.push("credit-released"); }),
    onConfirmedProviderSend: vi.fn(), releaseBeforePermit: vi.fn() };
  const recipientFailure = { afterPersistedRejection: vi.fn(async () => {
    events.push("reachability");
  }) };
  const deps = {
    database: { $queryRawUnsafe: vi.fn(async () => [{
      id: "conv-1", shopId: "shop-1", recoveryId: "recovery-1",
    }]), $executeRawUnsafe: vi.fn(async () => 1) },
    evaluator: { evaluateHumanCommand: vi.fn(async () => ({ kind: "ready" })) },
    commands: { loadClaimedCommand: vi.fn(async () => ({ kind: "claimed", command })) },
    execution: { evaluate: vi.fn(async () => ({ allowed: true })) },
    moderation: { effectiveText: vi.fn(async () => "Hello"),
      assessText: vi.fn(async () => ({ kind: "allow" })),
      requireCurrentAllowance: vi.fn(async () => true) },
    senderPreflight: vi.fn(async () => undefined),
    storedConsent: { preflight: vi.fn(async () => ({ kind: "allowed", snapshot: null })) },
    templateCategories: { verify: vi.fn(async () => "MARKETING") },
    followUps: { claimSequenceTwo: vi.fn(async () => ({ kind: "claimed", attemptId: "attempt-1" })) },
    followUpCancellations: { cancelClaimed: vi.fn(), repairCancelledClaims: vi.fn() },
    fence: { admitFinalSend: vi.fn(async () => ({ kind: "admitted" })) },
    provider: { sendWhatsAppTemplate: vi.fn(async () => { throw error; }),
      sendWhatsAppText: vi.fn(async () => { throw error; }) },
    reconciliation, billing, recipientFailure, now: () => new Date("2026-10-22T15:00:00.000Z"),
  } as unknown as HumanDispatcherDependencies;
  return { dispatcher: new HumanCommandDispatcherService(deps), billing, reconciliation,
    recipientFailure, events, provider: deps.provider, deps };
}

describe("ARCH-028-BACKGROUND-006 synchronous HUMAN recovery boundary", () => {
  it("corrects only after persisted 131026 on an admitted recovery follow-up", async () => {
    const x = fixture("RECOVERY_FOLLOW_UP_TEMPLATE");
    await x.dispatcher.processClaim("cmd-1", "lease-1");
    expect(x.events).toEqual(["persisted:131026", "credit-released", "reachability"]);
    expect(x.recipientFailure.afterPersistedRejection).toHaveBeenCalledWith("message-1");
    expect(x.billing.onDefinitiveProviderFailure).toHaveBeenCalledOnce();
    await x.dispatcher.close();
  });

  it("does not apply recovery credit correction or reachability to HUMAN_TEXT", async () => {
    const x = fixture("HUMAN_TEXT");
    await x.dispatcher.processClaim("cmd-1", "lease-1");
    expect(x.events).toEqual(["persisted:provider_rejected"]);
    expect(x.recipientFailure.afterPersistedRejection).not.toHaveBeenCalled();
    expect(x.billing.onDefinitiveProviderFailure).not.toHaveBeenCalled();
    await x.dispatcher.close();
  });
});


describe("ARCH-045 merchant recovery Marketing admission", () => {
  it("denies withdrawn consent before claiming sequence two, billing or Meta", async () => {
    const x = fixture("RECOVERY_FOLLOW_UP_TEMPLATE");
    vi.mocked(x.deps.storedConsent!.preflight).mockResolvedValue({ kind: "denied", reason: "stored-consent-denied" });
    await x.dispatcher.processClaim("cmd-1", "lease-1");
    expect(x.deps.followUps.claimSequenceTwo).not.toHaveBeenCalled();
    expect(x.billing.admitAndRevalidate).not.toHaveBeenCalled();
    expect(x.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(x.deps.followUpCancellations.cancelClaimed).toHaveBeenCalled();
    await x.dispatcher.close();
  });
  it.each(["UTILITY", "AUTHENTICATION", null])(
    "denies %s provider template category before billing", async (category) => {
      const x = fixture("RECOVERY_FOLLOW_UP_TEMPLATE");
      vi.mocked(x.deps.templateCategories!.verify).mockResolvedValue(category as never);
      await x.dispatcher.processClaim("cmd-1", "lease-1");
      expect(x.deps.followUps.claimSequenceTwo).not.toHaveBeenCalled();
      expect(x.billing.admitAndRevalidate).not.toHaveBeenCalled();
      expect(x.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      await x.dispatcher.close();
    },
  );
  it("keeps HUMAN_TEXT a service-window reply; final STOP fence remains mandatory", async () => {
    const x = fixture("HUMAN_TEXT");
    vi.mocked(x.deps.storedConsent!.preflight).mockResolvedValue({ kind: "denied", reason: "stored-consent-denied" });
    await x.dispatcher.processClaim("cmd-1", "lease-1");
    expect(x.deps.storedConsent!.preflight).not.toHaveBeenCalled();
    expect(x.deps.templateCategories!.verify).not.toHaveBeenCalled();
    expect(x.deps.fence.admitFinalSend).toHaveBeenCalledOnce();
    await x.dispatcher.close();
  });
});
