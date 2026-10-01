import {
  CommerceEnvironmentSchema,
  type CommerceEnvironment,
} from "@modainteract/moda-interact-shared/commerce/model";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";

const ENVIRONMENTS = {
  local: "LOCAL",
  test: "TEST",
  development: "DEVELOPMENT",
  staging: "STAGING",
  production: "PRODUCTION",
} as const satisfies Record<string, CommerceEnvironment>;

export function resolveCommerceEnvironment(): CommerceEnvironment {
  const name = resolveDeploymentEnvironmentName().toLowerCase();
  const parsed = CommerceEnvironmentSchema.safeParse(
    ENVIRONMENTS[name as keyof typeof ENVIRONMENTS],
  );
  if (!parsed.success)
    throw new Error("Commerce deployment environment is invalid");
  return parsed.data;
}