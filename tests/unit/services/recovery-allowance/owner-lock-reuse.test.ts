import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
vi.mock("../../../../src/services/recovery-delivery-compensation/reserved.js", () => ({ releaseReservedSource: vi.fn() }));
vi.mock("../../../../src/services/recovery-conversation/recovery-conversation.sql.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../src/services/recovery-conversation/recovery-conversation.sql.js")>(),
  lockRecoveryContext: vi.fn(), readRecoveryWindowEvidence: vi.fn(),
}));
vi.mock("../../../../src/services/whatsapp-contact-opt-out/local-no-contact.js", () => ({ hasLocalNoContact: vi.fn() }));

import { adoptInitial, createSuccessor, currentAllowance } from "../../../../src/services/recovery-allowance/storage.js";
import { lockRecoveryContext, readRecoveryWindowEvidence, type RecoveryContext } from "../../../../src/services/recovery-conversation/recovery-conversation.sql.js";
import { hasLocalNoContact } from "../../../../src/services/whatsapp-contact-opt-out/local-no-contact.js";

const owner: RecoveryContext = { id: "conversation-1", shopId: "shop-1", recoveryId: "recovery-1", checkoutToken: "checkout-1",
  recoveryStatus: "MESSAGE_SENT", mode: "AI", revision: 1, inboundVersion: 0, lastInboundAt: null };
const limits = { outboundHardLimit: 20, terminalMessageReservedSlots: 2 };
const now = new Date("2026-11-27T00:00:00Z");
const block = { id: "initial-allowance", state: "ACTIVE", fundingKind: "INITIAL", ordinal: 0, creditReservationId: "original-credit" };
const successor = { id: "follow-up-allowance", state: "PENDING", fundingKind: "FOLLOW_UP", ordinal: 1, predecessorId: block.id };

function fixture() {
  const models = {
    conversationAllowanceBlock: { findFirst: vi.fn().mockResolvedValue(block), aggregate: vi.fn().mockResolvedValue({ _max: { ordinal: 0 } }), create: vi.fn().mockResolvedValue(successor) },
    recoveryOutreachAttempt: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
  };
  return { models, tx: models as unknown as Prisma.TransactionClient };
}

describe("allowance owner locks within one transaction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(lockRecoveryContext).mockResolvedValue(owner);
    vi.mocked(readRecoveryWindowEvidence).mockResolvedValue({ platform: "SHOPIFY", initialAttemptId: "attempt-1", recipient: "447700900001",
      initialSentAt: new Date(now.getTime() - 60_000), followUpDueAt: now, verifiedInboundAt: null });
    vi.mocked(hasLocalNoContact).mockResolvedValue(false);
  });

  it("locks once for direct initial allowance adoption and still checks retry identity", async () => {
    const { models, tx } = fixture();
    await expect(adoptInitial(tx, owner.id, limits)).resolves.toEqual(block);
    expect(lockRecoveryContext).toHaveBeenCalledTimes(1);
    expect(lockRecoveryContext).toHaveBeenCalledWith(tx, owner.id);
    expect(models.recoveryOutreachAttempt.findFirst).toHaveBeenCalledWith({ where: { checkoutRecoveryId: owner.recoveryId, sequence: { gte: 3 }, trigger: "INITIAL" }, select: { id: true } });
  });

  it("locks once when resolving the current allowance", async () => {
    const { models, tx } = fixture();
    await expect(currentAllowance(tx, owner.id, limits)).resolves.toEqual(block);
    expect(lockRecoveryContext).toHaveBeenCalledTimes(1);
    expect(lockRecoveryContext).toHaveBeenCalledWith(tx, owner.id);
    expect(models.conversationAllowanceBlock.findFirst).toHaveBeenCalledTimes(2);
    expect(models.recoveryOutreachAttempt.findFirst).toHaveBeenCalledTimes(1);
  });

  it.each(["SHOPIFY", "WOOCOMMERCE"])("locks once for a %s follow-up successor without dropping admission checks", async platform => {
    const { models, tx } = fixture();
    vi.mocked(readRecoveryWindowEvidence).mockResolvedValue({ platform, initialAttemptId: "attempt-1", recipient: "447700900001", initialSentAt: new Date(now.getTime() - 60_000), followUpDueAt: now, verifiedInboundAt: null });
    await expect(createSuccessor(tx, { conversationId: owner.id, limits, now, kind: "FOLLOW_UP" })).resolves.toEqual({ block: successor, context: owner });
    expect(lockRecoveryContext).toHaveBeenCalledTimes(1);
    expect(lockRecoveryContext).toHaveBeenCalledWith(tx, owner.id);
    expect(readRecoveryWindowEvidence).toHaveBeenCalledTimes(1);
    expect(readRecoveryWindowEvidence).toHaveBeenCalledWith(tx, { recoveryId: owner.recoveryId, conversationId: owner.id, now });
    expect(hasLocalNoContact).toHaveBeenCalledTimes(1);
    expect(hasLocalNoContact).toHaveBeenCalledWith(tx, { shopId: owner.shopId, recipient: "447700900001" });
    expect(models.recoveryOutreachAttempt.findFirst).toHaveBeenCalledTimes(1);
    expect(models.conversationAllowanceBlock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ conversationId: owner.id, shopId: owner.shopId, fundingKind: "FOLLOW_UP", state: "PENDING", ordinal: 1, predecessorId: block.id }) });
  });

  it("does not read or create allowance state if the owner lock fails", async () => {
    const { models, tx } = fixture();
    vi.mocked(lockRecoveryContext).mockResolvedValue(null);
    await expect(currentAllowance(tx, owner.id, limits)).rejects.toThrow("owner-unavailable");
    expect(models.conversationAllowanceBlock.findFirst).not.toHaveBeenCalled();
    expect(models.conversationAllowanceBlock.create).not.toHaveBeenCalled();
  });

  it("retains the existing fail-closed retry delivery guard even with an initial allowance", async () => {
    const { models, tx } = fixture();
    models.recoveryOutreachAttempt.findFirst.mockResolvedValue({ id: "retry-1" });
    await expect(currentAllowance(tx, owner.id, limits)).rejects.toThrow("initial-retry-delivery-unproven");
    expect(lockRecoveryContext).toHaveBeenCalledTimes(1);
    expect(lockRecoveryContext).toHaveBeenCalledWith(tx, owner.id);
    expect(models.recoveryOutreachAttempt.findMany).toHaveBeenCalledTimes(1);
    expect(models.conversationAllowanceBlock.create).not.toHaveBeenCalled();
  });

  it("retains the no-contact guard before preparing a successor", async () => {
    const { models, tx } = fixture();
    vi.mocked(hasLocalNoContact).mockResolvedValue(true);
    await expect(createSuccessor(tx, { conversationId: owner.id, limits, now, kind: "FOLLOW_UP" })).rejects.toThrow("contact-blocked");
    expect(models.conversationAllowanceBlock.findFirst).not.toHaveBeenCalled();
    expect(models.conversationAllowanceBlock.create).not.toHaveBeenCalled();
  });
});
