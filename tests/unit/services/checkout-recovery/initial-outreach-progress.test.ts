import { describe, expect, it, vi } from "vitest";
import type { LogRecord } from "@modainteract/moda-interact-shared/logging";

const state = vi.hoisted(() => ({
  records: [] as LogRecord[],
  recovery: { id: "recovery-1", shopId: "shop-1", status: "DETECTED" },
  shop: { id: "shop-1", platform: "SHOPIFY" },
  attempt: { id: "attempt-1", checkoutRecoveryId: "recovery-1", sequence: 1, trigger: "INITIAL",
    status: "PENDING", sentAt: null, outboundMessageId: null, followUpDueAt: null },
  findShop: vi.fn(), inspect: vi.fn(),
}));

vi.mock("@modainteract/moda-interact-shared/logging", async (importOriginal) => {
  const shared = await importOriginal<typeof import("@modainteract/moda-interact-shared/logging")>();
  return { ...shared, createLogger: (options: Parameters<typeof shared.createLogger>[0]) => shared.createLogger({
    ...options, sink: (record) => state.records.push(JSON.parse(JSON.stringify(record)) as LogRecord),
  }) };
});
vi.mock("../../../../src/lib/db.js", () => ({ default: {
  checkoutRecovery: { findUnique: vi.fn(async () => state.recovery) },
  shop: { findUnique: state.findShop },
  recoveryOutreachAttempt: { findFirst: vi.fn(async () => state.attempt) },
} }));
vi.mock("../../../../src/services/outbound-whatsapp-admission.service.js", () => ({
  outboundWhatsAppAdmissionService: { inspectInitialOutreachAdmission: state.inspect },
}));

import { RecoveryInitiationService } from "../../../../src/services/checkout-recovery/recovery-initiation.service.js";

function service() {
  const billing = {
    revalidateExistingInitialOutreach: vi.fn(async () => ({ kind: "absent" })),
    settleConfirmedInitialOutreach: vi.fn(),
  };
  const finalize = { finalizeConfirmedInitialOutreach: vi.fn(async () => ({
    kind: "finalized" as const, outboundMessageId: "message-1", sentAt: new Date("2026-10-27T10:00:00Z"),
  })) };
  return { instance: new RecoveryInitiationService(billing as never, finalize as never), billing, finalize };
}

describe("durable initial outreach progress", () => {
  it("rethrows the source error and emits its safe Shared record with stage and identity", async () => {
    state.records.length = 0;
    const source = new Error("progress classification database outage phone +447000111222");
    state.findShop.mockRejectedValueOnce(source);
    const { instance } = service();
    await expect(instance.continueInitialOutreach({ shopId: "shop-1", recoveryId: "recovery-1" })).rejects.toBe(source);
    expect(state.records).toContainEqual(expect.objectContaining({
      event: "recovery.initial_outreach.progress.failed", level: "error",
      data: expect.objectContaining({ shopId: "shop-1", recoveryId: "recovery-1", stage: "classification",
        sourceError: expect.objectContaining({ message: "progress classification database outage phone [REDACTED_PHONE]" }) }),
    }));
  });

  it("reports a held provider state without finalization or success", async () => {
    state.records.length = 0;
    state.findShop.mockResolvedValueOnce(state.shop);
    state.inspect.mockResolvedValueOnce({ kind: "held", reason: "provider-outcome-unknown" });
    const { instance, finalize } = service();
    await expect(instance.continueInitialOutreach({ shopId: "shop-1", recoveryId: "recovery-1" }))
      .resolves.toEqual({ kind: "held", recoveryId: "recovery-1", reason: "provider-outcome-unknown" });
    expect(finalize.finalizeConfirmedInitialOutreach).not.toHaveBeenCalled();
  });
});
