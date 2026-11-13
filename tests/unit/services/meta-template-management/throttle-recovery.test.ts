import { describe, expect, it, vi } from "vitest";
import { MetaThrottlePreclaimRecovery, THROTTLE_ATTESTATION } from "../../../../src/services/meta-template-management/throttle-recovery.js";
const config={appId:"123",wabaId:"456"};
const proof={service:"moda-messaging-worker",reference:"synthetic:deployment"} as const;
const evidence={sha256:"a".repeat(64),reference:"synthetic:protected-evidence",attestation:THROTTLE_ATTESTATION,
  operation:"sample_session",httpStatus:403,providerErrorCode:4,registrationIds:["exact-id"]} as const;
const manifest={version:1,kind:"sample-app-code4",environment:"TEST",externalEvidence:evidence,
  preclaim:{version:1,operator:"synthetic:operator",...config,messagingWorkerProof:proof,
    entries:[{id:"exact-id",updatedAt:new Date(0).toISOString(),snapshotDigest:"b".repeat(64)}]}};
function fixture(){
  const transaction=vi.fn(async()=>({}));
  return {transaction,recovery:new MetaThrottlePreclaimRecovery({$transaction:transaction} as never,async()=>config,()=>"TEST")};
}
describe("exact operator throttle recovery boundary",()=>{
  it("uses explicit bounded30s serializable transactions for plan and revalidation",async()=>{
    const f=fixture();
    await f.recovery.plan(["exact-id"],"synthetic:operator",proof,evidence);
    expect(f.transaction).toHaveBeenLastCalledWith(expect.any(Function),{isolationLevel:"Serializable",timeout:30000});
    await f.recovery.recover(manifest);
    expect(f.transaction).toHaveBeenLastCalledWith(expect.any(Function),{isolationLevel:"Serializable",timeout:30000});
  });
  it("retains the20-ID cap and explicit numeric403/code4 exact-cohort attestation",async()=>{
    for(const ids of [[],["exact-id","exact-id"],Array.from({length:21},(_,i)=>`id${i}`)]){
      const f=fixture();await expect(f.recovery.plan(ids,"synthetic:operator",proof,{...evidence,registrationIds:ids})).rejects.toThrow();expect(f.transaction).not.toHaveBeenCalled();
    }
    for(const bad of [{...evidence,providerErrorCode:"4"},{...evidence,httpStatus:401},{...evidence,attestation:""},{...evidence,registrationIds:["foreign-id"]}]){
      const f=fixture();await expect(f.recovery.plan(["exact-id"],"synthetic:operator",proof,bad as never)).rejects.toThrow();expect(f.transaction).not.toHaveBeenCalled();
    }
  });
  it("requires exact apply digest and environment/configuration before SQL",async()=>{
    const f=fixture();await expect(f.recovery.recover(manifest,{apply:true})).rejects.toMatchObject({code:"RECOVERY_DIGEST_MISMATCH"});expect(f.transaction).not.toHaveBeenCalled();
    await expect(f.recovery.recover({...manifest,environment:"PRODUCTION"})).rejects.toMatchObject({code:"RECOVERY_CONFIGURATION_CHANGED"});expect(f.transaction).not.toHaveBeenCalled();
  });
});
