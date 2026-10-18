/** Server-only composition root. No database reads or provider calls during import. */
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { createPrismaConfigurationRepository } from "./repository.js";
import {
  createBackgroundPlatformConfigurationService, createExternalUnsealKeyringProvider,
} from "./service.js";

export function createProductionBackgroundPlatformConfiguration() {
  return createBackgroundPlatformConfigurationService({
    repository: createPrismaConfigurationRepository(prisma),
    environment: resolveDeploymentEnvironmentName(),
    unsealKeyring: createExternalUnsealKeyringProvider(),
  });
}
