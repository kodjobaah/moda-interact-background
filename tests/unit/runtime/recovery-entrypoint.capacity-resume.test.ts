import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = readFileSync(
  resolve(root, "src/entrypoints/recovery.ts"),
  "utf8",
);

describe("recovery entrypoint capacity-resume wiring", () => {
  it("uses the shared dynamic leased scheduler for repair", () => {
    expect(source).toContain("startDynamicLeasedScheduler");
    expect(source).toContain('leaseName: "RECOVERY_CAPACITY_REPAIR"');
    expect(source).toContain("recoveryRepairIntervalSeconds * 1000");
    expect(source).toContain("recoveryCapacityResumeService.repair(runtimeConfig)");
    expect(source).not.toContain("setInterval");
    expect(source).not.toContain("void recoveryCapacityResumeService.repair();");
  });

  it("starts all recovery workers and observes all queues", () => {
    for (const worker of [
      "pendingRecoveryCandidateWorker",
      "recoveryCapacityResumeWorker",
      "recoveryOutreachFollowUpWorker",
      "shopifyDiscountSyncWorker",
    ]) {
      expect(source).toContain(worker);
    }
    for (const queueName of [
      "pending-recovery-candidates",
      "recovery-capacity-resume",
      "recovery-outreach-follow-up",
      "shopify-discount-sync",
    ]) {
      expect(source).toContain(`"${queueName}"`);
    }
  });

  it("stops the repair scheduler and closes the resume queue on shutdown", () => {
    expect(source).toContain("stopRepairScheduler");
    expect(source).toContain(
      "() => recoveryCapacityResumeService.close()",
    );
  });
});
