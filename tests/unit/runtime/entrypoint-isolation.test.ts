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
  {
    file: "src/entrypoints/billing.ts",
    script: "start:billing-worker",
    command: "node --import ./observability/billing.mjs dist/entrypoints/billing.js",
    readinessScript: "readiness:billing-worker",
    readinessCommand: "node dist/readiness.js moda-billing-worker",
    serviceName: "moda-billing-worker",
    ownedWorkers: [],
    excludedWorkers: ["checkout.worker.js", "orders.worker.js", "pending-recovery-candidate.worker.js", "whatsapp.worker.js"],
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

  it("keeps the billing entrypoint on its dedicated resource bundle", async () => {
    const source = await readFile("src/entrypoints/billing.ts", "utf8");

    expect(source).not.toContain('import("./resources.js")');
    expect(source).toContain("connectionRedis");
    expect(source).toContain('import("./billing-resources.js")');
  });

  it("uses one queue-aware reconciliation service for the worker and repair cadence", async () => {
    const source = await readFile("src/entrypoints/billing.ts", "utf8");

    expect(source).toContain("new BillingSubscriptionReconciliationService(undefined, undefined, billingSubscriptionQueue)");
    expect(source).toContain("createBillingSubscriptionReconciliationWorker(subscriptionReconciliation)");
    expect(source).toContain("await subscriptionReconciliation.reconstruct()");
    expect(source).toContain("startQueuePerformanceTelemetry");
    expect(source).toContain("queueNames: [billingSubscriptionQueue.name as QueueName]");
    expect(source).toContain("stopQueuePerformanceTelemetry");
    expect(source).toContain("closeResources: [");
  });

  it("wires bounded Shared logging for scheduled billing failures", async () => {
    const source = await readFile("src/entrypoints/billing.ts", "utf8");
    const reporterStart = source.indexOf("function reportBillingReconciliationFailure");
    const reporterEnd = source.indexOf("\n\nvoid startReadyWorkerProcess", reporterStart);
    const reporter = source.slice(reporterStart, reporterEnd);

    expect(source).toContain('import { createLogger } from "@modainteract/moda-interact-shared/logging"');
    expect(source).toContain('serviceName: "moda-billing-worker"');
    expect(source).toContain('logger.error("billing.reconciliation.scan_failed"');
    expect(source).toContain("reportBillingReconciliationFailure,");
    expect(reporter).toContain("error.name.slice(0, 64)");
    expect(reporter).toContain("error.message.slice(0, 256)");
    expect(reporter).not.toContain("error,");
    expect(reporter).not.toContain("error: error");
  });
});