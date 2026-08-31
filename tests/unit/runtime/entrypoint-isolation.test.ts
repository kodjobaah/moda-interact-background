import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const entrypoints = [
  {
    file: "src/entrypoints/shopify-event.ts",
    script: "start:shopify-event-worker",
    command:
      "node --import ./observability/shopify-event.mjs dist/entrypoints/shopify-event.js",
    readinessScript: "readiness:shopify-event-worker",
    readinessCommand: "node dist/readiness.js moda-shopify-event-worker",
    serviceName: "moda-shopify-event-worker",
    ownedWorkers: ["checkout.worker.js", "orders.worker.js"],
    excludedWorkers: ["pending-recovery-candidate.worker.js", "whatsapp.worker.js"],
  },
  {
    file: "src/entrypoints/recovery.ts",
    script: "start:recovery-worker",
    command:
      "node --import ./observability/recovery.mjs dist/entrypoints/recovery.js",
    readinessScript: "readiness:recovery-worker",
    readinessCommand: "node dist/readiness.js moda-recovery-worker",
    serviceName: "moda-recovery-worker",
    ownedWorkers: ["pending-recovery-candidate.worker.js"],
    excludedWorkers: ["checkout.worker.js", "orders.worker.js", "whatsapp.worker.js"],
  },
  {
    file: "src/entrypoints/messaging.ts",
    script: "start:messaging-worker",
    command:
      "node --import ./observability/messaging.mjs dist/entrypoints/messaging.js",
    readinessScript: "readiness:messaging-worker",
    readinessCommand: "node dist/readiness.js moda-messaging-worker",
    serviceName: "moda-messaging-worker",
    ownedWorkers: ["whatsapp.worker.js"],
    excludedWorkers: [
      "checkout.worker.js",
      "orders.worker.js",
      "pending-recovery-candidate.worker.js",
    ],
  },
] as const;

describe("production worker entrypoints", () => {
  it.each(entrypoints)("isolates $serviceName", async (entrypoint) => {
    const source = await readFile(entrypoint.file, "utf8");

    expect(source).toContain(`serviceName: "${entrypoint.serviceName}"`);
    for (const worker of entrypoint.ownedWorkers) {
      expect(source).toContain(worker);
    }
    for (const worker of entrypoint.excludedWorkers) {
      expect(source).not.toContain(worker);
    }
    expect(source).not.toContain("node:http");
    expect(source).toContain("startReadyWorkerProcess");
    expect(source).toContain("loadWorkerProcess: async");
  });

  it("maps each logical service to a deterministic production command", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    for (const entrypoint of entrypoints) {
      expect(packageJson.scripts[entrypoint.script]).toBe(entrypoint.command);
      expect(packageJson.scripts[entrypoint.readinessScript]).toBe(
        entrypoint.readinessCommand,
      );
    }
  });
});