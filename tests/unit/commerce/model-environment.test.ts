import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveDeploymentEnvironmentName } = vi.hoisted(() => ({
  resolveDeploymentEnvironmentName: vi.fn(() => "development"),
}));

vi.mock("../../../src/runtime/deployment-environment.js", () => ({
  resolveDeploymentEnvironmentName,
}));

import { resolveCommerceEnvironment } from "../../../src/commerce/model-environment.js";

beforeEach(() => resolveDeploymentEnvironmentName.mockReset());

describe("resolveCommerceEnvironment", () => {
  it.each([
    ["local", "LOCAL"],
    ["TEST", "TEST"],
    ["Development", "DEVELOPMENT"],
    ["staging", "STAGING"],
    ["Production", "PRODUCTION"],
  ])("maps %s to %s", (deploymentName, expected) => {
    resolveDeploymentEnvironmentName.mockReturnValue(deploymentName);
    expect(resolveCommerceEnvironment()).toBe(expected);
  });

  it.each(["", " prod", "preview", "production-like"])(
    "rejects unsupported deployment name %j",
    (deploymentName) => {
      resolveDeploymentEnvironmentName.mockReturnValue(deploymentName);
      expect(resolveCommerceEnvironment).toThrow(
        "Commerce deployment environment is invalid",
      );
    },
  );
});