import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const boundaries = [
  {
    path: "src/workers/checkout.worker.ts",
    serviceName: "moda-shopify-event-worker",
    worker: true,
  },
  {
    path: "src/workers/orders.worker.ts",
    serviceName: "moda-shopify-event-worker",
    worker: true,
  },
  {
    path: "src/workers/pending-recovery-candidate.worker.ts",
    serviceName: "moda-recovery-worker",
    worker: true,
  },
  {
    path: "src/workers/whatsapp.worker.ts",
    serviceName: "moda-messaging-worker",
    worker: true,
  },
  {
    path: "src/services/pending-recovery-candidate.service.ts",
    serviceName: "moda-shopify-event-worker",
    worker: false,
  },
] as const;

describe("background BullMQ telemetry wiring", () => {
  it.each(boundaries)(
    "uses the shared native adapter at $path",
    ({ path, serviceName, worker }) => {
      const source = readFileSync(path, "utf8");

      expect(source).toContain(
        "@modainteract/moda-interact-shared/observability/bullmq",
      );
      expect(source).toContain(`serviceName: "${serviceName}"`);
      expect(source).toContain("telemetry: bullMQTelemetry");
      if (worker) {
        expect(source).toContain("enableMetrics: false");
        expect(source).toContain("observeWorkerJob(workerMetricDefinition, job");
      } else {
        expect(source).not.toContain("enableMetrics: false");
        expect(source).not.toContain("observeWorkerJob");
      }
      expect(source).not.toMatch(/traceparent|baggage|prototype/i);
    },
  );

  it("wires exactly the four Workers and one background-owned Queue", () => {
    const sources = boundaries.map(({ path }) => readFileSync(path, "utf8"));

    expect(
      sources.reduce(
        (count, source) => count + (source.match(/telemetry: bullMQTelemetry/g)?.length ?? 0),
        0,
      ),
    ).toBe(5);
  });
});