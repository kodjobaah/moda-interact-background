import { describe, expect, it, vi } from "vitest";
import { readRecoveryWindowEvidence, type RecoveryDatabase } from
  "../../../../src/services/recovery-conversation/recovery-conversation.sql.js";
import { customerWindow, RecoveryFollowUpPolicyService, CUSTOMER_WINDOW_MS } from
  "../../../../src/services/recovery-conversation/recovery-follow-up-policy.service.js";

const now = new Date("2026-10-23T14:00:00.000Z");
const sentAt = new Date(now.getTime() - 2 * 60 * 60_000);
const context = {id:"conversation",shopId:"shop",recoveryId:"recovery",checkoutToken:"checkout",
  recoveryStatus:"MESSAGE_SENT",mode:"HUMAN",revision:1,lastInboundAt:now};

type Evidence = { initialAttemptId:string;recipient:string;initialSentAt:Date|null;
  followUpDueAt:Date|null;verifiedInboundAt:Date|null };
function harness(evidence: Evidence | null, fakeContext = context) {
  const queries: string[] = [];
  const db = {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM "whatsapp"."Conversation" c') && sql.includes('JOIN "commerce"'))
        return [fakeContext];
      if (sql.includes('FROM "whatsapp"."Conversation" c')) return [{conversationId:"conversation"}];
      if (sql.includes('FROM "commerce"."Shop" WHERE')) return [{id:"shop"}];
      if (sql.includes('FROM "whatsapp"."Conversation" WHERE')) return [{id:"conversation"}];
      if (sql.includes('FROM "commerce"."RecoveryOutreachAttempt" initial'))
        return evidence ? [evidence] : [];
      if (sql.includes('FROM "whatsapp"."ConversationMessage"')) return [];
      if (sql.includes('FROM "commerce"."RecoveryOutreachAttempt"') && sql.includes('"sequence"=2'))
        return [{id:"attempt",status:"PENDING",initiatedBy:null,initiationKey:null,outboundMessageId:null}];
      if (sql.includes('UPDATE "commerce"."RecoveryOutreachAttempt"') && sql.includes('RETURNING "id"'))
        return [{id:"attempt"}];
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string) => { queries.push(sql); return 1; }),
    $transaction: async (callback: (tx: unknown) => unknown) => callback(db),
  };
  return {db:db as unknown as RecoveryDatabase, queries};
}
const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  initialAttemptId:"initial",recipient:"15551234567",initialSentAt:sentAt,
  followUpDueAt:new Date(now.getTime() - 1),verifiedInboundAt:null,...overrides,
});

describe("ARCH-040-BACKGROUND-008 verified recovery policy", () => {
  it("uses the exact [verified inbound, +24h) boundary and never opens on future data", () => {
    expect(customerWindow(new Date(now.getTime()-CUSTOMER_WINDOW_MS),now).open).toBe(false);
    expect(customerWindow(new Date(now.getTime()-CUSTOMER_WINDOW_MS+1),now).open).toBe(true);
    expect(customerWindow(new Date(now.getTime()+1),now).open).toBe(false);
  });

  it("reads a provider-verified CUSTOMER row after sequence 1, not lastInboundAt", async () => {
    const test = harness(evidence());
    const actual = await new RecoveryFollowUpPolicyService(test.db).checkServiceWindow("conversation",now);
    expect(actual).toEqual({kind:"known",open:false,closesAt:null});
    const sql = test.queries.find(s=>s.includes('FROM "commerce"."RecoveryOutreachAttempt" initial'))!;
    expect(sql).toContain('"providerMessageId" IS NOT NULL');
    expect(sql).toContain(`"senderType"='CUSTOMER'`);
    expect(sql).toContain(`"direction"='INBOUND'`);
    expect(sql).toContain('msg."createdAt">=initial."sentAt"');
    expect(sql).toContain('msg."createdAt"<=$3');
    expect(sql).toContain('ORDER BY msg."createdAt" DESC, msg."id" DESC');
    const bounds = await readRecoveryWindowEvidence(test.db, {
      recoveryId:"recovery",conversationId:"conversation",now,
    });
    expect(bounds).toEqual(evidence());
  });

  it("opens text only with the newest verified row, even when the cached time is stale", async () => {
    const verified = new Date(now.getTime()-60_000);
    const test = harness(evidence({verifiedInboundAt:verified}),{...context,lastInboundAt:null});
    expect(await new RecoveryFollowUpPolicyService(test.db).checkServiceWindow("conversation",now))
      .toEqual({kind:"known",open:true,closesAt:new Date(verified.getTime()+CUSTOMER_WINDOW_MS)});
  });

  it.each([
    ["no initial",null,"no-initial-outreach"],
    ["disabled",evidence({followUpDueAt:null}),"follow-up-not-due"],
    ["future due",evidence({followUpDueAt:new Date(now.getTime()+1000)}),"follow-up-not-due"],
    ["open window",evidence({verifiedInboundAt:new Date(now.getTime()-1000)}),"customer-window-open"],
  ] as const)("rejects %s for merchant template before any claim",async (_state,row,reason)=>{
    const test=harness(row);
    const policy=new RecoveryFollowUpPolicyService(test.db);
    expect(await policy.validateHumanFollowUp({conversationId:"conversation",expectedRevision:1,now}))
      .toEqual({kind:"suppressed",reason});
    expect(await policy.claimSequenceTwo({initiator:"merchant_post_window",recoveryId:"recovery",
      expectedRevision:1,initiationKey:"key",recipient:"15551234567",now}))
      .toEqual({kind:"suppressed",reason});
    expect(test.queries.some(sql=>sql.includes('INSERT INTO "commerce"."RecoveryOutreachAttempt"'))).toBe(false);
  });

  it("claims the same sequence-two identity after a 15-minute due time, without waiting 24 hours", async()=>{
    const test=harness(evidence({initialSentAt:new Date(now.getTime()-15*60_000),followUpDueAt:now}));
    const claim=await new RecoveryFollowUpPolicyService(test.db).claimSequenceTwo({
      initiator:"merchant_post_window",recoveryId:"recovery",expectedRevision:1,
      initiationKey:"key",recipient:"15551234567",now,
    });
    expect(claim).toEqual({kind:"claimed",attemptId:"attempt",billingSource:"recovery-outreach:attempt"});
    expect(test.queries.some(sql=>sql.includes('FOR UPDATE OF initial'))).toBe(true);
  });
});
