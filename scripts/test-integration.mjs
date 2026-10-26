import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { withDisposableIntegrationInfrastructure } from "@modainteract/moda-interact-shared/testing/node";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { runWithPostgresStartupRetry } from "./integration-startup-retry.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prismaSchemaPath = path.join(repositoryRoot, "database", "prisma", "schema.prisma");
const vitestBinary = path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const defaultTests = [
  "tests/integration/background-runtime-lease-cadence.concurrency.integration.test.ts",
  "tests/integration/translation-batch-assembly.concurrency.integration.test.ts",
  "tests/integration/bullmq-telemetry.integration.test.ts",
  "tests/integration/conversation-turn-scheduling.integration.test.ts",
  "tests/integration/translation-enum-bindings.integration.test.ts",
];
const selectedTests = process.argv.slice(2);

function runVitest(environment, tests) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [vitestBinary, "run", ...tests],
      {
        cwd: repositoryRoot,
        // The database and Redis are disposable; policy selection must be equally
        // deterministic. Never inherit a developer/deployment environment into
        // these integration tests (TEST is the fixture policy namespace).
        env: {
          ...process.env,
          ...environment,
          DEPLOYMENT_ENVIRONMENT_NAME: "test",
          MODA_DISPOSABLE_INTEGRATION: "1",
        },
        stdio: "inherit",
      },
    );

    const forwardSignal = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    process.once("SIGINT", forwardSignal);
    process.once("SIGTERM", forwardSignal);

    child.once("error", (error) => {
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
      resolve({ code, signal });
    });
  });
}

const integrationLogger = createLogger({
  serviceName: "moda-background-integration-test-runner",
  environment: "test",
});

const result = await runWithPostgresStartupRetry(
  () => withDisposableIntegrationInfrastructure(
    {
      prismaSchemaPath,
      cwd: repositoryRoot,
      postgres: { image: "pgvector/pgvector:pg17" },
    },
    async ({ environment }) => runVitest(
      environment, selectedTests.length > 0 ? selectedTests : defaultTests,
    ),
  ),
  integrationLogger,
);

if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exitCode = result.code ?? 1;