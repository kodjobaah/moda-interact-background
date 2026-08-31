import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
};
const dockerfile = readFileSync("Dockerfile", "utf8");

const workerProfiles = [
  {
    serviceName: "moda-shopify-event-worker",
    script: "start:shopify-event-worker",
    profile: "shopify-event",
    entrypoint: "shopify-event",
  },
  {
    serviceName: "moda-recovery-worker",
    script: "start:recovery-worker",
    profile: "recovery",
    entrypoint: "recovery",
  },
  {
    serviceName: "moda-messaging-worker",
    script: "start:messaging-worker",
    profile: "messaging",
    entrypoint: "messaging",
  },
] as const;

describe("production worker observability startup", () => {
  it.each(workerProfiles)(
    "preloads shared observability before $serviceName imports",
    ({ serviceName, script, profile, entrypoint }) => {
      const preloadPath = `./observability/${profile}.mjs`;
      const preloadSource = readFileSync(preloadPath, "utf8");
      const entrypointSource = readFileSync(
        `src/entrypoints/${entrypoint}.ts`,
        "utf8",
      );

      expect(packageJson.scripts[script]).toBe(
        `node --import ${preloadPath} dist/entrypoints/${entrypoint}.js`,
      );
      expect(preloadSource).toContain(
        "@modainteract/moda-interact-shared/observability/node",
      );
      expect(preloadSource).toContain(`serviceName: "${serviceName}"`);
      expect(preloadSource).toContain('serviceNamespace: "moda-interact"');
      expect(preloadSource).toContain(
        "instrument: { http: true, fetch: true, prisma: true }",
      );
      expect(preloadSource).not.toMatch(/bullmq|genai/i);
      expect(entrypointSource).toContain("closeWorkerObservability");
      expect(entrypointSource).toContain(
        "...closeWorkerResources, closeWorkerObservability",
      );
      expect(entrypointSource).toContain("await closeWorkerObservability()");
    },
  );

  it.each(workerProfiles)(
    "keeps hosted export disableable for $serviceName",
    ({ serviceName, profile }) => {
      const probe = spawnSync(
        process.execPath,
        [
          "--import",
          `./observability/${profile}.mjs`,
          "--input-type=module",
          "--eval",
          [
            'import { getNodeObservabilityRuntime, initNodeObservability } from "@modainteract/moda-interact-shared/observability/node";',
            "const runtime = getNodeObservabilityRuntime();",
            'const duplicate = initNodeObservability({ serviceName: "duplicate-runtime" });',
            "console.log(JSON.stringify({ enabled: runtime?.enabled, serviceName: runtime?.serviceName, environment: runtime?.environment, singleton: runtime === duplicate }));",
            "await runtime?.shutdown();",
          ].join(" "),
        ],
        {
          cwd: resolve("."),
          encoding: "utf8",
          env: {
            ...process.env,
            DEPLOYMENT_ENVIRONMENT_NAME: "test",
            OTEL_SDK_DISABLED: "true",
            OTEL_EXPORTER_OTLP_ENDPOINT: "",
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
            OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "",
          },
        },
      );

      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout.trim())).toEqual({
        enabled: false,
        serviceName,
        environment: "test",
        singleton: true,
      });
    },
  );

  it("uses the architect-approved exact shared runtime release", () => {
    expect(
      packageJson.dependencies["@modainteract/moda-interact-shared"],
    ).toBe("0.5.0");
  });

  it("packages every production observability preload", () => {
    expect(dockerfile).toContain("COPY observability ./observability");
  });
});