import "dotenv/config";
import { describe, expect, it } from "vitest";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";
import { currentRecoveryShopHeaderMatches } from "../../src/services/recovery-conversation/recovery-shop-header-verification.js";
import { recoveryShopHeaderPrefix, verifiedRecoveryShopHeader } from "../../src/services/conversation-wrappers/recovery-shop-header.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
suite("ARCH-073 durable tenant header identity", () => {
 it("freezes named header, retains authored bytes and sends the identical moderated body", async () => {
  const f = await humanDispatchFixture("header-human", {checkoutLifetimeDays:7});
  const dispatcher = f.dispatcher();
  try {
   await f.db.shopBrand.create({data:{shopId:f.shopId,brandName:"Eugene Fixture"}});
   const url = `https://${f.shopId}.example.test/checkouts/trusted`;
   await f.db.checkoutRecovery.update({where:{id:f.recoveryId},data:{checkoutUrl:url}});
   const authored = "  Merchant authored\nkeep all bytes  ";
   const id = await f.addCommand({textBody:authored});
   const claim = (await f.commands.claimDueHumanCommands({limit:1,now:new Date()}))[0]!;
   const loaded = await f.commands.loadClaimedCommand(id,claim.leaseToken);
   if(loaded.kind !== "claimed") throw new Error("claim missing");
   const frozen = await f.preparation.freeze(loaded.command,claim.leaseToken);
   const receipt = verifiedRecoveryShopHeader(f.shopId,`${f.shopId}.example.test`,"Eugene Fixture")!;
   expect(frozen).toMatchObject({kind:"frozen",evidence:{recoveryShopHeader:receipt}});
   if(frozen.kind !== "frozen") throw new Error("freeze refused");
   expect(frozen.body.startsWith(recoveryShopHeaderPrefix(receipt)+authored)).toBe(true);
   expect(frozen.body.endsWith(url)).toBe(true);
   await dispatcher.processClaim(id,claim.leaseToken);
   const persisted = await f.db.merchantConversationSendCommand.findUniqueOrThrow({where:{id}});
   expect(persisted.preparedTextBody).toBe(frozen.body);
   expect(persisted.textBody).toBe(authored);
   expect(f.provider.sendWhatsAppText).toHaveBeenCalledWith(expect.objectContaining({text:frozen.body}));
  } finally {await dispatcher.close();await f.close();}
 },120_000);
 for(const change of ["name","domain"] as const) it(`rejects a committed ${change} race after waiting for the Shop lock`,async()=>{
  const f = await humanDispatchFixture(`header-${change}`);
  try {
   await f.db.shopBrand.create({data:{shopId:f.shopId,brandName:"Original"}});
   const receipt = verifiedRecoveryShopHeader(f.shopId,`${f.shopId}.example.test`,"Original")!;
   const body = recoveryShopHeaderPrefix(receipt)+"Answer";
   expect(await f.db.$transaction(tx=>currentRecoveryShopHeaderMatches(tx,receipt,body,f.shopId))).toBe(true);
   let release!:()=>void;let locked!:()=>void;
   const ready=new Promise<void>(resolve=>{locked=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
   const mutation=f.db.$transaction(async tx=>{
    await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`,f.shopId);
    if(change==="name") await tx.shopBrand.update({where:{shopId:f.shopId},data:{brandName:"Renamed"}});
    else await tx.shop.update({where:{id:f.shopId},data:{domain:"renamed.example.test"}});
    locked();await gate;
   });
   await ready;
   const pending=f.db.$transaction(tx=>currentRecoveryShopHeaderMatches(tx,receipt,body,f.shopId));
   await new Promise(resolve=>setTimeout(resolve,40));release();await mutation;
   expect(await pending).toBe(false);
   expect(await f.db.$transaction(tx=>currentRecoveryShopHeaderMatches(tx,{...receipt,shopId:"other"},body,f.shopId))).toBe(false);
  } finally {await f.close();}
 },120_000);
});
