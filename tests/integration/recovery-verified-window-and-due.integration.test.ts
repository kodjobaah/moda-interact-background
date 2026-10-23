import "dotenv/config";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CUSTOMER_WINDOW_MS } from "../../src/services/recovery-conversation/recovery-follow-up-policy.service.js";
import { recoveryWindowFixture } from "./fixtures/arch040-window.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;
const minutes = (m: number) => m * 60_000;
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);

suite("ARCH-040-BACKGROUND-008 verified window and configured due-time admission", () => {
  it.each([
    ["one millisecond before 24h closes", CUSTOMER_WINDOW_MS - 1, "admitted"],
    ["exactly at 24h", CUSTOMER_WINDOW_MS, "suppressed"],
    ["one millisecond after 24h", CUSTOMER_WINDOW_MS + 1, "suppressed"],
  ])("final HUMAN text permit %s", async (_label, age, expected) => {
    const f = await recoveryWindowFixture(`text-${age}`);
    try {
      await f.seedInitial(ago(f.now, CUSTOMER_WINDOW_MS * 2), null);
      await f.inbound(ago(f.now, age));
      const cmd = await f.command("HUMAN_TEXT");
      const result = await f.permit(cmd.id, cmd.token);
      expect(result.kind).toBe(expected);
      if (expected === "suppressed") expect(result).toEqual({kind:"suppressed",reason:"customer-window-closed"});
      const persisted = await f.db.merchantConversationSendCommand.findUniqueOrThrow({where:{id:cmd.id}});
      expect(persisted.providerDispatchKey === null).toBe(expected === "suppressed");
    } finally { await f.close(); }
  }, 60_000);

  it.each(["unverified", "pre-initial", "future", "no-initial"])(
    "does not let cached lastInboundAt or %s customer evidence open the window", async (state) => {
      const f = await recoveryWindowFixture(`invalid-${state}`);
      try {
        if (state !== "no-initial") await f.seedInitial(ago(f.now, minutes(120)), null);
        if (state === "unverified") await f.inbound(ago(f.now, minutes(1)), false);
        if (state === "pre-initial") await f.inbound(ago(f.now, minutes(121)));
        if (state === "future") await f.inbound(new Date(f.now.getTime() + minutes(1)));
        expect(await f.policy.checkServiceWindow(f.conversationId, f.now))
          .toMatchObject({ kind: "known", open: false });
        const cmd = await f.command("HUMAN_TEXT");
        expect((await f.permit(cmd.id, cmd.token)).kind).toBe("suppressed");
      } finally { await f.close(); }
    }, 60_000);

  it.each([15,60,2880])("permits a deliberate HUMAN template when configured %im is due (no fixed 24h delay)", async (delay) => {
    const f = await recoveryWindowFixture(`due-${delay}`);
    try {
      await f.seedInitial(ago(f.now, minutes(delay)), f.now);
      const key = `merchant-${randomUUID()}`;
      const claim = await f.policy.claimSequenceTwo({
        recoveryId: f.recoveryId, recipient: f.recipient, now: f.now,
        initiator: "merchant_post_window", expectedRevision: 1, initiationKey: key,
      });
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") return;
      const cmd = await f.command("RECOVERY_FOLLOW_UP_TEMPLATE", claim.attemptId, key);
      expect((await f.permit(cmd.id, cmd.token)).kind).toBe("admitted");
      expect(await f.db.recoveryOutreachAttempt.count({ where: {
        checkoutRecoveryId: f.recoveryId, sequence: 2,
      } })).toBe(1);
    } finally { await f.close(); }
  }, 60_000);

  it.each(["disabled", "not-yet-due"])("denies %s HUMAN follow-up without burning sequence 2", async (state) => {
    const f = await recoveryWindowFixture(`off-${state}`);
    try {
      await f.seedInitial(ago(f.now, minutes(60)),
        state === "disabled" ? null : new Date(f.now.getTime() + minutes(60)));
      expect(await f.policy.validateHumanFollowUp({ conversationId: f.conversationId,
        expectedRevision: 1, now: f.now })).toMatchObject({kind:"suppressed",reason:"follow-up-not-due"});
      expect(await f.policy.claimSequenceTwo({recoveryId:f.recoveryId,recipient:f.recipient,
        now:f.now,initiator:"merchant_post_window",expectedRevision:1,
        initiationKey:randomUUID()})).toMatchObject({kind:"suppressed",reason:"follow-up-not-due"});
      expect(await f.db.recoveryOutreachAttempt.count({where:{checkoutRecoveryId:f.recoveryId,sequence:2}})).toBe(0);
    } finally { await f.close(); }
  },60_000);

  it("rechecks a changed due time after a claim but before final provider admission", async () => {
    const f = await recoveryWindowFixture("due-moved");
    try {
      const initialId = await f.seedInitial(ago(f.now, minutes(60)), f.now);
      const key = randomUUID();
      const claim = await f.policy.claimSequenceTwo({recoveryId:f.recoveryId,recipient:f.recipient,
        now:f.now,initiator:"merchant_post_window",expectedRevision:1,initiationKey:key});
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") return;
      const cmd = await f.command("RECOVERY_FOLLOW_UP_TEMPLATE",claim.attemptId,key);
      await f.db.recoveryOutreachAttempt.update({where:{id:initialId},
        data:{followUpDueAt:new Date(f.now.getTime()+minutes(60))}});
      expect(await f.permit(cmd.id,cmd.token)).toEqual({kind:"suppressed",reason:"follow-up-not-due"});
      expect((await f.db.merchantConversationSendCommand.findUniqueOrThrow({where:{id:cmd.id}})).providerDispatchKey).toBeNull();
    } finally { await f.close(); }
  },60_000);

  it("blocks template claims in a verified open window; expired engagement permanently suppresses scheduled no-response",async()=>{
    const f = await recoveryWindowFixture("engaged");
    try {
      await f.seedInitial(ago(f.now, CUSTOMER_WINDOW_MS*3),ago(f.now,CUSTOMER_WINDOW_MS*2));
      await f.inbound(ago(f.now,minutes(2)));
      const input = {recoveryId:f.recoveryId,recipient:f.recipient,now:f.now,
        initiator:"merchant_post_window" as const,expectedRevision:1,initiationKey:randomUUID()};
      expect(await f.policy.claimSequenceTwo(input)).toMatchObject({kind:"suppressed",reason:"customer-window-open"});
      await f.db.conversationMessage.deleteMany({ where: {conversationId:f.conversationId,direction:"INBOUND"} });
      await f.inbound(ago(f.now,CUSTOMER_WINDOW_MS+minutes(1)));
      expect((await f.policy.claimSequenceTwo({recoveryId:f.recoveryId,recipient:f.recipient,
        now:f.now,initiator:"scheduled_no_response",initiationKey:randomUUID()})))
        .toMatchObject({kind:"suppressed",reason:"human-controlled"});
      await f.aiMode();
      expect(await f.policy.claimSequenceTwo({recoveryId:f.recoveryId,recipient:f.recipient,
        now:f.now,initiator:"scheduled_no_response",initiationKey:randomUUID()}))
        .toMatchObject({kind:"suppressed",reason:"customer-engaged"});
    } finally {await f.close();}
  },60_000);

  it("automated free text needs verified inbound but a Meta template can initiate outreach",async()=>{
    const f = await recoveryWindowFixture("auto-kind");
    try {
      await f.aiMode();
      const prepare = async () => (await f.db.conversationMessage.create({data:{
        conversationId:f.conversationId,direction:"OUTBOUND",senderType:"AUTOMATION",status:"PENDING",content:"Prepared",
      }})).id;
      const textId=await prepare();
      const text=await f.fence.admitFinalSend({senderType:"AUTOMATION",deliveryKind:"TEXT",
        conversationId:f.conversationId,shopId:f.shopId,recoveryId:f.recoveryId,
        expectedControlRevision:2,messageId:textId,recipient:f.recipient,now:f.now});
      expect(text).toEqual({kind:"suppressed",reason:"no-initial-outreach"});
      const templateId=await prepare();
      const template=await f.fence.admitFinalSend({senderType:"AUTOMATION",deliveryKind:"TEMPLATE",
        conversationId:f.conversationId,shopId:f.shopId,recoveryId:f.recoveryId,
        expectedControlRevision:2,messageId:templateId,recipient:f.recipient,now:f.now});
      expect(template.kind).toBe("admitted");
    } finally { await f.close(); }
  },60_000);

  it("denies a queued HUMAN text whose caller sampled one millisecond before expiry",async()=>{
    const f=await recoveryWindowFixture("queued-expiry");
    try {
      await f.seedInitial(ago(f.now,CUSTOMER_WINDOW_MS*2),null);
      await f.inbound(ago(f.now,CUSTOMER_WINDOW_MS));
      const cmd=await f.command("HUMAN_TEXT");
      expect(await f.fence.admitFinalSend({senderType:"HUMAN",conversationId:f.conversationId,
        recoveryId:f.recoveryId,shopId:f.shopId,commandId:cmd.id,leaseToken:cmd.token,
        expectedControlRevision:1,recipient:f.recipient,
        now:new Date(f.now.getTime()-1)}))
        .toEqual({kind:"suppressed",reason:"customer-window-closed"});
    } finally {await f.close();}
  },60_000);

  it("rechecks a newly verified reply after sequence 2 was claimed, before provider admission",async()=>{
    const f=await recoveryWindowFixture("new-reply");
    try {
      await f.seedInitial(ago(f.now,minutes(60)),ago(f.now,minutes(45)));
      const key=randomUUID();
      const claim=await f.policy.claimSequenceTwo({recoveryId:f.recoveryId,recipient:f.recipient,
        now:f.now,initiator:"merchant_post_window",expectedRevision:1,initiationKey:key});
      expect(claim.kind).toBe("claimed");
      if (claim.kind!=="claimed") return;
      const cmd=await f.command("RECOVERY_FOLLOW_UP_TEMPLATE",claim.attemptId,key);
      await f.inbound(ago(f.now,minutes(1)));
      expect(await f.permit(cmd.id,cmd.token)).toEqual({kind:"suppressed",reason:"customer-window-open"});
      expect(await f.db.conversationMessage.count({where:{conversationId:f.conversationId,senderType:"HUMAN"}})).toBe(0);
    } finally {await f.close();}
  },60_000);

  it("concurrent merchant contenders cannot claim another sequence-2 attempt",async()=>{
    const f=await recoveryWindowFixture("concurrent-claims");
    try {
      await f.seedInitial(ago(f.now,minutes(90)),ago(f.now,minutes(60)));
      const claim=(key:string)=>f.policy.claimSequenceTwo({recoveryId:f.recoveryId,recipient:f.recipient,
        now:f.now,initiator:"merchant_post_window",expectedRevision:1,initiationKey:key});
      const results=await Promise.all([claim(randomUUID()),claim(randomUUID())]);
      expect(results.filter(r=>r.kind==="claimed")).toHaveLength(1);
      expect(results.filter(r=>r.kind==="suppressed")).toHaveLength(1);
      expect(await f.db.recoveryOutreachAttempt.count({where:{checkoutRecoveryId:f.recoveryId,sequence:2}})).toBe(1);
    } finally {await f.close();}
  },60_000);

});
