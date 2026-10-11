import { describe, expect, it, vi } from "vitest";
import { RecoveryRecipientSuppressionAdmissionService } from "../../../../src/services/checkout-recovery/recovery-recipient-suppression-admission.service.js";

const { schedule } = vi.hoisted(() => ({ schedule: vi.fn() }));
vi.mock("../../../../src/services/recovery-capacity-resume.service.js", () => ({
  recoveryCapacityResumeService: { schedule },
}));
const updatedAt = new Date("2026-10-11T00:00:00.000Z");

function currentRecovery(admissionBlockReason: string | null = null) {
  return { status: "DETECTED", admissionBlockReason, updatedAt };
}

describe("RecoveryRecipientSuppressionAdmissionService", () => {
  it("looks up only the exact Shop and canonical recipient key", async () => {
    const findUnique = vi.fn(async () => ({ suppressUntil: new Date("2026-10-12T00:00:00Z") }));
    const service = new RecoveryRecipientSuppressionAdmissionService({
      whatsAppRecipientReachability: { findUnique },
    } as never);

    await service.evaluate("shop-1", "15551234567", new Date("2026-10-11T00:00:00Z"));

    expect(findUnique).toHaveBeenCalledWith({
      where: { shopId_recipient: { shopId: "shop-1", recipient: "15551234567" } },
      select: { suppressUntil: true },
    });
  });

  it("blocks until an active suppression deadline", async () => {
    const until = new Date("2026-10-12T00:00:00Z");
    const service = new RecoveryRecipientSuppressionAdmissionService({
      whatsAppRecipientReachability: {
        findUnique: vi.fn(async () => ({ suppressUntil: until })),
      },
    } as never);

    await expect(service.evaluate("shop-1", "15551234567", new Date("2026-10-11T00:00:00Z")))
      .resolves.toEqual({ kind: "suppressed", until });
  });

  it.each([
    ["missing", null],
    ["expired", { suppressUntil: new Date("2026-10-10T00:00:00Z") }],
  ])("allows a %s reachability row", async (_label, row) => {
    const service = new RecoveryRecipientSuppressionAdmissionService({
      whatsAppRecipientReachability: {
        findUnique: vi.fn(async () => row),
      },
    } as never);

    await expect(service.evaluate("shop-1", "15551234567", new Date("2026-10-11T00:00:00Z")))
      .resolves.toEqual({ kind: "allowed" });
  });

  it("schedules the expiry wake-up before durably blocking the eligible recovery", async () => {
    const until = new Date("2026-10-12T00:00:00Z");
    const updateMany = vi.fn(async () => ({ count: 1 }));
    schedule.mockImplementationOnce(async () => "job-1");
    const service = new RecoveryRecipientSuppressionAdmissionService({
      whatsAppRecipientReachability: { findUnique: vi.fn() },
      checkoutRecovery: {
        findUnique: vi.fn(async () => currentRecovery()),
        updateMany,
      },
    } as never);

    await expect(service.deferDetectedRecovery("recovery-1", "shop-1", until)).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "recovery-1", status: "DETECTED", updatedAt },
      data: {
        admissionBlockedAt: expect.any(Date),
        admissionBlockReason: "WHATSAPP_RECIPIENT_SUPPRESSED",
      },
    });
    expect(schedule).toHaveBeenCalledWith({
      shopId: "shop-1",
      recoveryId: "recovery-1",
      trigger: `recipient-suppression-recovery-1-${until.getTime()}`,
    }, until);
  });

  it("does not persist a suppression block when expiry scheduling fails", async () => {
    schedule.mockClear();
    const enqueueError = new Error("queue unavailable");
    schedule.mockRejectedValueOnce(enqueueError);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const service = new RecoveryRecipientSuppressionAdmissionService({
      whatsAppRecipientReachability: { findUnique: vi.fn() },
      checkoutRecovery: {
        findUnique: vi.fn(async () => currentRecovery()),
        updateMany,
      },
    } as never);

    await expect(service.deferDetectedRecovery(
      "recovery-1",
      "shop-1",
      new Date("2026-10-12T00:00:00Z"),
    )).rejects.toMatchObject({
      message: "RECIPIENT_SUPPRESSION_RESUME_ENQUEUE_FAILED",
      cause: enqueueError,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("leaves a harmless scheduled wake-up when the recovery is no longer DETECTED", async () => {
    schedule.mockClear();
    const service = new RecoveryRecipientSuppressionAdmissionService({
      whatsAppRecipientReachability: { findUnique: vi.fn() },
      checkoutRecovery: {
        findUnique: vi.fn(async () => ({ ...currentRecovery(), status: "CANCELLED" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    } as never);

    await expect(service.deferDetectedRecovery(
      "recovery-1",
      "shop-1",
      new Date("2026-10-12T00:00:00Z"),
    )).resolves.toBe(false);
    expect(schedule).toHaveBeenCalledOnce();
  });

  it("gives concurrent duplicate deferrals the same deterministic resume job", async () => {
    schedule.mockClear();
    const until = new Date("2026-10-12T00:00:00Z");
    const service = new RecoveryRecipientSuppressionAdmissionService({
      whatsAppRecipientReachability: { findUnique: vi.fn() },
      checkoutRecovery: {
        findUnique: vi.fn(async () => currentRecovery()),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    } as never);

    await Promise.all([
      service.deferDetectedRecovery("recovery-1", "shop-1", until),
      service.deferDetectedRecovery("recovery-1", "shop-1", until),
    ]);

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule.mock.calls[0]).toEqual(schedule.mock.calls[1]);
  });

  it("derives a distinct deterministic child trigger from an active wake-up", async () => {
    schedule.mockClear();
    const until = new Date("2026-10-12T00:00:00Z");
    const service = new RecoveryRecipientSuppressionAdmissionService({
      whatsAppRecipientReachability: { findUnique: vi.fn() },
      checkoutRecovery: {
        findUnique: vi.fn(async () => currentRecovery()),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    } as never);
    const activeTrigger = `recipient-suppression-recovery-1-${until.getTime()}`;

    await Promise.all([
      service.deferDetectedRecovery("recovery-1", "shop-1", until, activeTrigger),
      service.deferDetectedRecovery("recovery-1", "shop-1", until, activeTrigger),
    ]);

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule.mock.calls[0]).toEqual(schedule.mock.calls[1]);
    expect(schedule.mock.calls[0]?.[0].trigger).not.toBe(activeTrigger);
  });

  it("clears only an expired suppression block from a still-detected recovery", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const service = new RecoveryRecipientSuppressionAdmissionService({
      whatsAppRecipientReachability: { findUnique: vi.fn() },
      checkoutRecovery: {
        findUnique: vi.fn(async () => currentRecovery("WHATSAPP_RECIPIENT_SUPPRESSED")),
        updateMany,
      },
    } as never);

    await service.clearDetectedSuppression("recovery-1");

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-1",
        status: "DETECTED",
        updatedAt,
        OR: [
          { admissionBlockReason: null },
          { admissionBlockReason: "WHATSAPP_RECIPIENT_SUPPRESSED" },
        ],
      },
      data: {
        admissionBlockedAt: null,
        admissionBlockReason: null,
        updatedAt: expect.any(Date),
      },
    });
  });
});