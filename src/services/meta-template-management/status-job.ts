import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import {
  META_TEMPLATE_STATUS_JOB,
  MetaTemplateStatusObservationV2Schema,
  formatMetaTemplateStatusJobId,
} from "@modainteract/moda-interact-shared/whatsapp-template-events";
import { MetaManagementError, safeMetaError } from "./contracts.js";
import { metaTemplateManagementService } from "./service.js";

const logger = createLogger({
  serviceName: "moda-messaging-worker", environment: resolveDeploymentEnvironmentName(),
});

/** Strict Shared-v2 validation happens BEFORE the local Meta business port.
 * Provider GET and DB mutation are delegated to the owning BG003 service. */
export async function processTemplateStatusJob(jobName: string, raw: unknown, jobId?: string): Promise<void> {
  try {
    if (jobName !== META_TEMPLATE_STATUS_JOB) {
      throw new MetaManagementError("INVALID_TEMPLATE_STATUS_JOB_NAME", "blocked");
    }
    const parsed = MetaTemplateStatusObservationV2Schema.safeParse(raw);
    if (!parsed.success) throw new MetaManagementError("INVALID_TEMPLATE_STATUS_V2", "blocked");
    const input = parsed.data;
    const observationId = input.eventIdentity.slice("meta-template-status:v2:".length);
    if (jobId !== formatMetaTemplateStatusJobId(observationId)) {
      throw new MetaManagementError("INVALID_TEMPLATE_STATUS_JOB_ID", "blocked");
    }
    await metaTemplateManagementService.processTemplateStatusObservation({
      eventIdentity: input.eventIdentity,
      wabaId: input.wabaId,
      ...(input.providerTemplateId ? { providerTemplateId: input.providerTemplateId } : {}),
      providerTemplateName: input.providerTemplateName,
      providerLanguageCode: input.providerLanguageCode,
      providerStatus: input.providerStatus,
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      occurredAt: input.receivedAt,
    });
  } catch (error) {
    logger.error("whatsapp.template_status.failed", {
      jobId: typeof jobId === "string" ? jobId.slice(0, 192) : null,
      ...safeMetaError(error),
    });
    throw error; // BullMQ retry/failure diagnostics, never silently acknowledge.
  }
}
