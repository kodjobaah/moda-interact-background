import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

const exporter = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE,
);
const reader = new PeriodicExportingMetricReader({
  exporter,
  exportIntervalMillis: 60_000,
});
const provider = new MeterProvider({ readers: [reader] });
metrics.setGlobalMeterProvider(provider);

const meter = provider.getMeter(
  "@modainteract/moda-interact-shared/observability/genai",
);
const histograms: Array<{ record: (...args: unknown[]) => void }> = [];
const counters: Array<{ add: (...args: unknown[]) => void }> = [];
const originalCreateHistogram = meter.createHistogram.bind(meter);
const originalCreateCounter = meter.createCounter.bind(meter);

meter.createHistogram = (...args) => {
  const histogram = originalCreateHistogram(...args);
  histograms.push(histogram);
  return histogram;
};
meter.createCounter = (...args) => {
  const counter = originalCreateCounter(...args);
  counters.push(counter);
  return counter;
};

const {
  observeAgentInvocation,
  observeAgentTool,
  observeConversationTurn,
} = await import(
  "@modainteract/moda-interact-shared/observability/genai"
);

const sensitiveValue = "SECRET_CUSTOMER_CONVERSATION_PAYLOAD";

for (let index = 0; index < 40; index += 1) {
  await observeAgentInvocation(
    {
      agentName: `agent-${index}-${sensitiveValue}`,
      provider: `provider-${index}-${sensitiveValue}`,
      model: `model-${index}-${sensitiveValue}`,
    },
    async () => "agent-result",
  );
  await observeAgentTool(
    `tool-${index}-${sensitiveValue}`,
    async () => "tool-result",
  );
}

await observeConversationTurn("whatsapp", async () => "turn-result");

for (const operation of [
  () => observeAgentInvocation(
    { agentName: `failed-agent-${sensitiveValue}` },
    async () => Promise.reject(new Error("expected agent error")),
  ),
  () => observeAgentTool(
    `failed-tool-${sensitiveValue}`,
    async () => Promise.reject(new Error("expected tool error")),
  ),
  () => observeConversationTurn(
    "other",
    async () => Promise.reject(new Error("expected turn error")),
  ),
]) {
  try {
    await operation();
  } catch {
    // Expected application failures remain observable by their callers.
  }
}

await provider.forceFlush();

const collected = exporter.getMetrics().flatMap((resourceMetrics) =>
  resourceMetrics.scopeMetrics.flatMap((scopeMetrics) =>
    scopeMetrics.metrics.map((metric) => ({
      name: metric.descriptor.name,
      points: metric.dataPoints.map((point) => ({
        attributes: point.attributes,
        value: point.value,
      })),
    })),
  ),
);

const originalHistogramRecords = histograms.map(
  (histogram) => histogram.record.bind(histogram),
);
for (const histogram of histograms) {
  histogram.record = () => {
    throw new Error("metric duration failure");
  };
}

const durationFailureResult = await observeAgentInvocation(
  { agentName: "failure-isolation-agent" },
  async () => "application-result",
);
const durationApplicationError = new Error("duration application error");
let durationErrorIdentity = false;
try {
  await observeAgentTool(
    "failure-isolation-tool",
    async () => Promise.reject(durationApplicationError),
  );
} catch (error) {
  durationErrorIdentity = error === durationApplicationError;
}

histograms.forEach((histogram, index) => {
  histogram.record = originalHistogramRecords[index]!;
});
for (const counter of counters) {
  counter.add = () => {
    throw new Error("metric counter failure");
  };
}

const counterFailureResult = await observeConversationTurn(
  "whatsapp",
  async () => "turn-application-result",
);
const counterApplicationError = new Error("counter application error");
let counterErrorIdentity = false;
try {
  await observeAgentInvocation(
    { agentName: "counter-failure-agent" },
    async () => Promise.reject(counterApplicationError),
  );
} catch (error) {
  counterErrorIdentity = error === counterApplicationError;
}

console.log(`GENAI_METRICS ${JSON.stringify({
  collected,
  instruments: {
    histograms: histograms.length,
    counters: counters.length,
  },
  failureIsolation: {
    durationFailureResult,
    durationErrorIdentity,
    counterFailureResult,
    counterErrorIdentity,
  },
})}`);

await provider.shutdown();