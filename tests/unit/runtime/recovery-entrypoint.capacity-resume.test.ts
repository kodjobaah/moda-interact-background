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
  it("runs repair at startup and every five minutes", () => {
    expect(source).toContain(
      "await recoveryCapacityResumeService.repair();",
    );
    expect(source).toContain(
      "const repairInterval = setInterval(() => {",
    );
    expect(source).toContain(
      "void recoveryCapacityResumeService.repair();",
    );
    expect(source).toContain("}, 5 * 60 * 1000);");
  });

  it("starts both recovery workers and observes both queues", () => {
    expect(source).toContain(
      "workers: [pendingRecoveryCandidateWorker, recoveryCapacityResumeWorker]",
    );
    expect(source).toContain(
      'queueNames: ["pending-recovery-candidates", "recovery-capacity-resume"]',
    );
  });

  it("clears the repair timer and closes the resume queue on shutdown", () => {
    expect(source).toContain("clearInterval(repairInterval)");
    expect(source).toContain(
      "() => recoveryCapacityResumeService.close()",
    );
  });
});
