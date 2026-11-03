import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
import { FollowUpClaimKeyIntegrityError, MerchantSendCommandService } from
  "../../../../src/services/recovery-conversation/merchant-send-command.service.js";
import type { RecoveryDatabase } from
  "../../../../src/services/recovery-conversation/recovery-conversation.sql.js";

function command(kind: "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE", followUpClaimKey: string | null) {
  return {
    id: "command", idempotencyKey: "http-replay-key", followUpClaimKey,
    shopId: "shop", conversationId: "conversation", kind, state: "CLAIMED",
    leaseToken: "lease", leaseExpiresAt: new Date("2099-01-01"), expectedControlRevision: 1,
    recipientSnapshot: "15551234567", textBody: "hello", templateName: null,
    templateLanguageCode: null, templateParameters: null, recoveryOutreachAttemptId: null,
    outboundMessageId: null, providerDispatchKey: null,
  };
}

function service(record: ReturnType<typeof command>) {
  const query = vi.fn(async (sql: string) => sql.includes("MerchantConversationSendCommand")
    ? [record] : [{ id: "conversation", shopId: "shop", recoveryId: "recovery",
      checkoutToken: "checkout", recoveryStatus: "MESSAGE_SENT", mode: "HUMAN",
      revision: 1, lastInboundAt: null }]);
  const database = { $queryRawUnsafe: query, $executeRawUnsafe: vi.fn() } as unknown as RecoveryDatabase;
  return { commands: new MerchantSendCommandService(database), query };
}

describe("ARCH-055-BACKGROUND-001 persisted human follow-up identity", () => {
  it("retains the historical persisted owner independently from HTTP idempotency", async () => {
    const record = command("RECOVERY_FOLLOW_UP_TEMPLATE", "migrated-owner-key");
    const { commands } = service(record);
    const loaded = await commands.loadClaimedCommand("command", "lease");
    expect(loaded).toMatchObject({ kind: "claimed", command: {
      idempotencyKey: "http-replay-key", followUpClaimKey: "migrated-owner-key",
    } });
  });

  it.each([null, "   "])("rejects a missing or blank template claim identity (%s)", async (key) => {
    const { commands, query } = service(command("RECOVERY_FOLLOW_UP_TEMPLATE", key));
    await expect(commands.loadClaimedCommand("command", "lease"))
      .rejects.toBeInstanceOf(FollowUpClaimKeyIntegrityError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not require a follow-up key for HUMAN_TEXT", async () => {
    const { commands } = service(command("HUMAN_TEXT", null));
    expect(await commands.loadClaimedCommand("command", "lease"))
      .toMatchObject({ kind: "claimed", command: { kind: "HUMAN_TEXT", followUpClaimKey: null } });
  });
});
