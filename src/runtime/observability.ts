import { getNodeObservabilityRuntime } from "@modainteract/moda-interact-shared/observability/node";

export async function closeWorkerObservability(): Promise<void> {
  await getNodeObservabilityRuntime()?.shutdown();
}