import http from "node:http";

import { closeWorkerResources } from "./entrypoints/resources.js";
import { startWorkerProcess } from "./runtime/worker-process.js";
import { backgroundRuntimeConfigService } from "./runtime/background-runtime-config.js";
import { backgroundRuntimeLeaseService } from "./runtime/background-runtime-lease.js";
import { startQueueConcurrencyController } from "./runtime/queue-concurrency-controller.js";

const port = Number(process.env.PORT ?? 3000);

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, {
      "Content-Type": "application/json",
    });

    response.end(
      JSON.stringify({
        status: "ok",
        service: "moda-interact-worker",
      }),
    );

    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/plain",
  });

  response.end("Moda Interact worker is running");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Health server listening on port ${port}`);
});

async function startDevelopmentWorker(): Promise<void> {
  await backgroundRuntimeConfigService.start();
  const [
    { createCheckoutWorker },
    { createOrderWorker },
    { createPendingRecoveryCandidateWorker },
    { createWhatsappWorker },
    { createShopifyDiscountSyncWorker },
  ] = await Promise.all([
    import("./workers/checkout.worker.js"),
    import("./workers/orders.worker.js"),
    import("./workers/pending-recovery-candidate.worker.js"),
    import("./workers/whatsapp.worker.js"),
    import("./workers/shopify-discount-sync.worker.js"),
  ]);
  const workers = [
    createCheckoutWorker(),
    createOrderWorker(),
    createPendingRecoveryCandidateWorker(),
    createWhatsappWorker(),
    createShopifyDiscountSyncWorker(),
  ];
  const stopQueueConcurrencyController = await startQueueConcurrencyController({
    config: backgroundRuntimeConfigService,
    lease: backgroundRuntimeLeaseService,
  });
  startWorkerProcess({
    serviceName: "moda-interact-worker-development",
    workers,
    closeResources: [
      stopQueueConcurrencyController,
      () => backgroundRuntimeConfigService.close(),
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        }),
      ...closeWorkerResources,
    ],
  });
}

void startDevelopmentWorker().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});