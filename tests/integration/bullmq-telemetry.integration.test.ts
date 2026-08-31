import { randomUUID } from "node:crypto";

import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { context, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { afterEach, describe, expect, it } from "vitest";

import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";

const redisUrl = process.env.TEST_REDIS_URL;
const redisIt = redisUrl ? it : it.skip;

type Candidate = {
  shopId: string;
  checkoutToken: string;
  cartToken: string | null;
  abandonedCheckoutUrl: string | null;
  checkoutCreatedAt: string | null;
};

const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).reverse().map((close) => close()));
});

async function createBoundary(
  processJob: (job: Job<Candidate>) => Promise<void>,
) {
  const queueName = `bullmq-telemetry-${randomUUID()}`;
  const queueRedis = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
  const workerRedis = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
  const telemetry = createBullMQTelemetry({
    serviceName: "moda-shopify-event-worker",
  });
  const queue = new Queue<Candidate>(queueName, {
    connection: queueRedis,
    telemetry,
  });
  const worker = new Worker<Candidate>(queueName, processJob, {
    connection: workerRedis,
    telemetry,
  });
  const completed = new Promise<void>((resolve, reject) => {
    worker.once("completed", () => resolve());
    worker.once("failed", (_job, error) => reject(error));
  });

  cleanup.push(
    () => queueRedis.quit(),
    () => workerRedis.quit(),
    () => queue.close(),
    () => worker.close(),
  );
  await worker.waitUntilReady();

  return { completed, queue, queueName };
}

describe.sequential("shared BullMQ telemetry", () => {
  redisIt("does not make telemetry a processing dependency", async () => {
    const processed = new Promise<Candidate>((resolve, reject) => {
      void createBoundary(async (job) => resolve(job.data))
        .then(async ({ completed, queue }) => {
          await queue.add("evaluate-pending-recovery", {
            shopId: "shop_1",
            checkoutToken: "checkout_1",
            cartToken: "cart_1",
            abandonedCheckoutUrl: null,
            checkoutCreatedAt: "2026-08-31T00:00:00Z",
          });
          await completed;
        })
        .catch(reject);
    });

    await expect(processed).resolves.toEqual({
      shopId: "shop_1",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-31T00:00:00Z",
    });
  });

  redisIt("propagates the parent trace without changing the payload", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const contextManager = new AsyncHooksContextManager().enable();
    provider.register({ contextManager });
    cleanup.push(
      async () => {
        contextManager.disable();
        await provider.shutdown();
      },
    );

    const candidate: Candidate = {
      shopId: "shop_1",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      abandonedCheckoutUrl: "https://shop.example/recover",
      checkoutCreatedAt: "2026-08-31T00:00:00Z",
    };
    let resolveProcessed!: (value: Candidate) => void;
    const processed = new Promise<Candidate>((resolve) => {
      resolveProcessed = resolve;
    });
    const { completed, queue, queueName } = await createBoundary(async (job) => {
      resolveProcessed(job.data);
    });
    const parent = provider.getTracer("background-test").startSpan("checkout-accepted");

    await context.with(trace.setSpan(context.active(), parent), () =>
      queue.add("evaluate-pending-recovery", candidate),
    );
    const received = await processed;
    await completed;
    parent.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await provider.forceFlush();

    expect(received).toEqual(candidate);
    const spans = exporter.getFinishedSpans();
    const producer = spans.find((span) => span.name.startsWith(`add ${queueName}`));
    const consumer = spans.find((span) => span.name.startsWith(`process ${queueName}`));

    expect(producer).toBeDefined();
    expect(consumer).toBeDefined();
    expect(producer?.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(consumer?.spanContext().traceId).toBe(parent.spanContext().traceId);
  });
});