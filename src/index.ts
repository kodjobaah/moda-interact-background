import http from "node:http";

import { closeWorkerResources } from "./entrypoints/resources.js";
import { startWorkerProcess } from "./runtime/worker-process.js";
import { checkoutWorker } from "./workers/checkout.worker.js";
import { orderWorker } from "./workers/orders.worker.js";
import { pendingRecoveryCandidateWorker } from "./workers/pending-recovery-candidate.worker.js";
import { whatsappWorker } from "./workers/whatsapp.worker.js";

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

startWorkerProcess({
  serviceName: "moda-interact-worker-development",
  workers: [
    checkoutWorker,
    orderWorker,
    pendingRecoveryCandidateWorker,
    whatsappWorker,
  ],
  closeResources: [
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