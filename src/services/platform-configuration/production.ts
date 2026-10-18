/** Server-only composition root. No database reads or provider calls during import. */
import prisma from "../../lib/db.js";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { createPrismaConfigurationRepository } from "./repository.js";
import {
  createBackgroundPlatformConfigurationService, createExternalUnsealKeyringProvider,
} from "./service.js";

export function createProductionBackgroundPlatformConfiguration() {
  const environment = resolveDeploymentEnvironmentName();
  return createBackgroundPlatformConfigurationService({
    repository: createPrismaConfigurationRepository(prisma),
    environment,
    logger: createLogger({ serviceName: "moda-background-runtime", environment }),
    unsealKeyring: createExternalUnsealKeyringProvider(),
  });
}
