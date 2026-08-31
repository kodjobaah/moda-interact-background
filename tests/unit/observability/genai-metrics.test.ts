import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type MetricPoint = {
  attributes: Record<string, unknown>;
  value: number | { count: number; sum?: number };
};

type Metric = {
  name: string;
  points: MetricPoint[];
};

type FixtureResult = {
  collected: Metric[];
  instruments: {
    histograms: number;
    counters: number;
  };
  failureIsolation: {
    durationFailureResult: string;
    durationErrorIdentity: boolean;
    counterFailureResult: string;
    counterErrorIdentity: boolean;
  };
};

const expectedMetricNames = [
  "moda.agent.invocation.duration_ms",
  "moda.agent.invocation.operations",
  "moda.agent.tool.duration_ms",
  "moda.agent.tool.operations",
  "moda.conversation.turn.duration_ms",
  "moda.conversation.turn.operations",
];

describe("CommerceAgent GenAI metrics", () => {
  it("emits bounded singleton metrics and isolates recording failures", async () => {
    const fixture = fileURLToPath(
      new URL("../../fixtures/genai-metrics.ts", import.meta.url),
    );
    const processResult = await spawnProcess([
      "--import",
      "tsx",
      fixture,
    ]);

    expect(processResult.code).toBe(0);
    const serialized = processResult.stdout.match(
      /^GENAI_METRICS (.+)$/m,
    )?.[1];
    expect(serialized, processResult.stderr).toBeDefined();
    const result = JSON.parse(serialized!) as FixtureResult;

    expect(result.collected.map((metric) => metric.name).sort()).toEqual(
      [...expectedMetricNames].sort(),
    );
    expect(result.instruments).toEqual({
      histograms: 3,
      counters: 3,
    });

    for (const metric of result.collected) {
      expect(metric.points).toHaveLength(2);
      for (const point of metric.points) {
        expect(Object.keys(point.attributes).sort()).toEqual(
          metric.name.startsWith("moda.conversation.turn")
            ? ["channel", "outcome"]
            : ["outcome"],
        );
        expect(point.attributes.outcome).toMatch(/^(success|error)$/);
        if ("channel" in point.attributes) {
          expect(point.attributes.channel).toMatch(/^(whatsapp|other)$/);
        }
      }
    }

    for (const name of expectedMetricNames) {
      const metric = result.collected.find((candidate) =>
        candidate.name === name
      );
      expect(metric).toBeDefined();
      const expectedSuccess = name.startsWith("moda.conversation.turn")
        ? 1
        : 40;
      expect(pointCount(metric!, "success")).toBe(expectedSuccess);
      expect(pointCount(metric!, "error")).toBe(1);
      if (name.endsWith("duration_ms")) {
        for (const point of metric!.points) {
          expect(point.value).toEqual(expect.objectContaining({
            count: expect.any(Number),
            sum: expect.any(Number),
          }));
          expect((point.value as { sum: number }).sum).toBeGreaterThanOrEqual(0);
        }
      }
    }

    expect(result.failureIsolation).toEqual({
      durationFailureResult: "application-result",
      durationErrorIdentity: true,
      counterFailureResult: "turn-application-result",
      counterErrorIdentity: true,
    });
    expect(serialized).not.toMatch(
      /SECRET_CUSTOMER_CONVERSATION_PAYLOAD|agent-\d|tool-\d|provider-\d|model-\d/,
    );
  });
});

function pointCount(
  metric: Metric,
  outcome: "success" | "error",
): number {
  const point = metric.points.find((candidate) =>
    candidate.attributes.outcome === outcome
  );
  expect(point).toBeDefined();
  return typeof point!.value === "number"
    ? point!.value
    : point!.value.count;
}

function spawnProcess(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: process.env });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}