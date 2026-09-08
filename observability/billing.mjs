import { initNodeObservability } from "@modainteract/moda-interact-shared/observability/node";

initNodeObservability({
  serviceName: "moda-billing-worker",
  serviceNamespace: "moda-interact",
  instrument: { http: true, fetch: true, prisma: true },
});