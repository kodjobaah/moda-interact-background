import { afterEach, describe, expect, it } from "vitest";

import { resolveDeploymentEnvironmentName } from "../../../src/runtime/deployment-environment.js";

const original = {
  DEPLOYMENT_ENVIRONMENT_NAME: process.env.DEPLOYMENT_ENVIRONMENT_NAME,
  OTEL_DEPLOYMENT_ENVIRONMENT: process.env.OTEL_DEPLOYMENT_ENVIRONMENT,
  NODE_ENV: process.env.NODE_ENV,
};

afterEach(() => {
  restore("DEPLOYMENT_ENVIRONMENT_NAME", original.DEPLOYMENT_ENVIRONMENT_NAME);
  restore("OTEL_DEPLOYMENT_ENVIRONMENT", original.OTEL_DEPLOYMENT_ENVIRONMENT);
  restore("NODE_ENV", original.NODE_ENV);
});

describe("deployment environment resolution", () => {
  it("prefers the explicit Render deployment environment over NODE_ENV", () => {
    process.env.DEPLOYMENT_ENVIRONMENT_NAME = "test";
    process.env.NODE_ENV = "production";

    expect(resolveDeploymentEnvironmentName()).toBe("test");
  });

  it("falls back to the OpenTelemetry deployment environment before NODE_ENV", () => {
    delete process.env.DEPLOYMENT_ENVIRONMENT_NAME;
    process.env.OTEL_DEPLOYMENT_ENVIRONMENT = "staging";
    process.env.NODE_ENV = "production";

    expect(resolveDeploymentEnvironmentName()).toBe("staging");
  });

  it("falls back to NODE_ENV when no explicit deployment environment is configured", () => {
    delete process.env.DEPLOYMENT_ENVIRONMENT_NAME;
    delete process.env.OTEL_DEPLOYMENT_ENVIRONMENT;
    process.env.NODE_ENV = "development";

    expect(resolveDeploymentEnvironmentName()).toBe("development");
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
