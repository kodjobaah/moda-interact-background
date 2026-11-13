import { describe, expect, it, vi } from "vitest";
import { MetaAppSampleOperation, resolveMetaAppScope, SAMPLE_OPERATION_DEADLINE_MS } from "../../../../src/services/meta-template-management/app-operation.js";
import { MetaManagementError } from "../../../../src/services/meta-template-management/contracts.js";
import { MetaImageHeaderSampleUploader } from "../../../../src/services/meta-template-management/image-header-sample.js";
const scope = resolveMetaAppScope("123", "test");
function fixture() {
  const lease = { ...scope, owner: "synthetic", generation: 1n };
  const repository = { acquire: vi.fn(async () => lease), verify: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined), throttle: vi.fn(async () => new Date(Date.now()+900000)) };
  return { repository, run: new MetaAppSampleOperation(repository as never) };
}
describe("bounded fenced app sample operation", () => {
  it("fails closed before work when database gate fails", async () => {
    const f=fixture(); const work=vi.fn(); f.repository.acquire.mockRejectedValueOnce(new Error("synthetic DB failure"));
    await expect(f.run.run(scope, work)).rejects.toThrow("synthetic DB failure"); expect(work).not.toHaveBeenCalled();
  });
  it("only valid successful work resets under ownership, and code4 persists cooldown", async () => {
    const f=fixture(); await expect(f.run.run(scope, async (_signal, verify) => { await verify(); return "ok"; })).resolves.toBe("ok");
    expect(f.repository.verify).toHaveBeenCalledOnce(); expect(f.repository.finish).toHaveBeenCalledWith(expect.anything(),true);
    const throttled=fixture();
    await expect(throttled.run.run(scope, async () => { throw new MetaManagementError("META_SAMPLE_APP_THROTTLED","uncertain",undefined,{httpStatus:403,providerErrorCode:4}); }))
      .rejects.toMatchObject({ code:"META_SAMPLE_APP_THROTTLED",diagnostics:{appId:"123",environment:"TEST",leaseGeneration:"1"} });
    expect(throttled.repository.throttle).toHaveBeenCalledOnce(); expect(throttled.repository.finish).not.toHaveBeenCalled();
  });
  it("bounds the entire source/read/upload operation within the120s lease", async () => {
    const f=fixture(); const request=vi.fn();
    const uploader=new MetaImageHeaderSampleUploader(request as typeof fetch,{read:()=>new Promise(()=>{})});
    const run=new MetaAppSampleOperation(f.repository as never,10);
    await expect(run.run(scope,(signal,beforeHttp)=>uploader.upload({appId:"123",accessToken:"synthetic",graphBase:"https://example.invalid",signal,beforeHttp}))).rejects.toMatchObject({disposition:"uncertain"});
    expect(request).not.toHaveBeenCalled(); expect(SAMPLE_OPERATION_DEADLINE_MS).toBe(90000);
    expect(f.repository.finish).toHaveBeenCalledWith(expect.anything(),false);
  });
  it("rejects invalid app/environment and unbounded deadline",()=>{
    expect(()=>resolveMetaAppScope("wrong","test")).toThrow(); expect(()=>resolveMetaAppScope("123","unknown")).toThrow();
    expect(()=>new MetaAppSampleOperation(undefined,120001)).toThrow();
  });
});
