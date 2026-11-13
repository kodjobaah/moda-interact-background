import { describe, expect, it, vi } from "vitest";
import { MetaPreclaimRecovery, parsePreclaimRecoveryArguments, parsePreclaimManifest, readPreclaimRecoveryConfiguration } from "../../../../src/services/meta-template-management/preclaim-recovery.js";
vi.mock("../../../../src/services/platform-configuration/consumers.js", () => ({ platformConsumerConfiguration: { read: vi.fn(async () => ({ value: { businessAccountId: "123", accessToken: "synthetic" } })) } }));
const entry = { id: "exact-id", updatedAt: new Date(0).toISOString(), snapshotDigest: "a".repeat(64) };
const proof = { service: "moda-messaging-worker", reference: "test:deployment-proof" };
const manifest = { messagingWorkerProof: proof, version: 1, operator: "test:operator", wabaId: "123", appId: "456", entries: [entry] };
describe("bounded operator preclaim recovery", () => {
  it.each([null, {}, { ...manifest, extra: true }, { ...manifest, entries: [] },
    { ...manifest, entries: [entry, entry] }, { ...manifest, entries: Array.from({ length: 21 }, (_, i) => ({ ...entry, id: `id${i}` })) },
    { ...manifest, entries: [{ ...entry, id: "*" }] }, { ...manifest, entries: [{ ...entry, snapshotDigest: "wrong" }] },
    { ...manifest, entries: [{ ...entry, updatedAt: "yesterday" }] }, { ...manifest, operator: "" }, { ...manifest, messagingWorkerProof: { ...proof, service: "moda-merchant-communications-worker" } },
  ])("rejects malformed/unbounded manifest before database access", (input) => {
    expect(() => parsePreclaimManifest(input)).toThrow();
  });
  it("defaults to planning/dry-run and requires exact apply flags and messaging-worker proof", () => {
    expect(parsePreclaimRecoveryArguments(["--ids", "id1,id2", "--operator", "change:1", "--messaging-worker-proof", "deploy:1"]).mode).toBe("plan");
    expect(parsePreclaimRecoveryArguments(["--manifest", "reviewed.json"])).toEqual({ mode: "manifest", path: "reviewed.json", apply: false });
    expect(parsePreclaimRecoveryArguments(["--manifest", "reviewed.json", "--apply", "--digest", "a".repeat(64)]).mode).toBe("manifest");
    for (const args of [[], ["--ids", "*"], ["--manifest", "x", "--apply"], ["--manifest", "x", "--manifest", "y"], ["--all"], ["--manifest", "x", "--digest", "a".repeat(64)]]) {
      expect(() => parsePreclaimRecoveryArguments(args)).toThrow();
    }
  });
  it("pins exact digest before configuration or transaction", async () => {
    const read = vi.fn(); const transaction = vi.fn();
    const recovery = new MetaPreclaimRecovery({ $transaction: transaction } as never, read);
    await expect(recovery.recover(manifest, { apply: true })).rejects.toMatchObject({ code: "RECOVERY_DIGEST_MISMATCH" });
    expect(read).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
  });
  it("requires repaired trusted app config without provider requests", async () => {
    const previous = process.env.META_APP_ID;
    const request = vi.spyOn(globalThis, "fetch");
    try {
      delete process.env.META_APP_ID;
      await expect(readPreclaimRecoveryConfiguration()).rejects.toMatchObject({ code: "RECOVERY_CONFIGURATION_INVALID" });
      process.env.META_APP_ID = "456";
      expect(await readPreclaimRecoveryConfiguration()).toEqual({ wabaId: "123", appId: "456" });
      expect(request).not.toHaveBeenCalled();
    } finally { if (previous === undefined) delete process.env.META_APP_ID; else process.env.META_APP_ID = previous; request.mockRestore(); }
  });
});
