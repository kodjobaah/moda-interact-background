import { describe, expect, it, vi } from "vitest";

const sharedLogger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
import { FollowUpClaimKeyIntegrityError, MerchantSendCommandService } from
  "../../../../src/services/recovery-conversation/merchant-send-command.service.js";
import { OutboundSendFenceService } from
  "../../../../src/services/recovery-conversation/outbound-send-fence.service.js";
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

  it("logs the outbound-fence integrity error message without exposing a key value", async () => {
    const context = { id: "conversation", shopId: "shop", recoveryId: "recovery",
      checkoutToken: "checkout", recoveryStatus: "MESSAGE_SENT", mode: "HUMAN",
      revision: 1, lastInboundAt: null };
    const command = { state: "CLAIMED", leaseToken: "lease",
      leaseExpiresAt: new Date("2099-01-01"), expectedControlRevision: 1,
      kind: "RECOVERY_FOLLOW_UP_TEMPLATE", recipientSnapshot: "15551234567",
      textBody: null, preparedTextBody: null, preparedWrapperEvidence: null, preparedAt: null,
      templateName: "follow_up", templateLanguageCode: "en_US", followUpClaimKey: null,
      recoveryOutreachAttemptId: "attempt", providerDispatchKey: null };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM "whatsapp"."Conversation" c')) return [context];
      if (sql.includes('SELECT "id" FROM "commerce"."Shop"')) return [{ id: "shop" }];
      if (sql.includes('SELECT "id" FROM "whatsapp"."Conversation"')) return [{ id: "conversation" }];
      if (sql.includes('SELECT "status"::text,"platform"::text FROM "commerce"."Shop"')) return [{ status: "ACTIVE", platform: "SHOPIFY" }];
      if (sql.includes('FROM "whatsapp"."MerchantConversationSendCommand"')) return [command];
      return [];
    });
    const db = { $queryRawUnsafe: query, $executeRawUnsafe: vi.fn(async () => 1),
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(db) };
    sharedLogger.error.mockClear();

    const permit = await new OutboundSendFenceService(db as unknown as RecoveryDatabase,
      async () => null).admitFinalSend({
      senderType: "HUMAN", conversationId: "conversation", shopId: "shop", recoveryId: "recovery",
      expectedControlRevision: 1, commandId: "command", leaseToken: "lease",
      recipient: "15551234567", now: new Date("2026-11-03T00:00:00Z"),
    });

    expect(permit).toEqual({ kind: "suppressed", reason: "follow-up-claim-key-integrity-failure" });
    const logged = sharedLogger.error.mock.calls.find(([event]) =>
      event === "arch055.follow_up_claim_key_integrity_failed")?.[1];
    expect(logged).toMatchObject({
      commandId: "command", shopId: "shop",
      errorType: "FollowUpClaimKeyIntegrityError",
      errorMessage: "Persisted human follow-up claim key is missing or blank",
      error: expect.any(FollowUpClaimKeyIntegrityError),
      reasonCode: "persisted_claim_key_missing",
    });
    expect(JSON.stringify(logged)).not.toContain("private-historical-owner");
  });
});
