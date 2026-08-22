import http from "node:http";

// Importing this starts your BullMQ worker
import "./workers/orders.worker.js";

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
  console.log("Moda Interact workers started");
});