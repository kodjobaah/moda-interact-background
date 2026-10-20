import { createHash } from "node:crypto";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import {
  createOperationalIncidentReporter,
  createPrismaOperationalIncidentPersistence,
  type OperationalIncidentPrismaClient,
} from "@modainteract/moda-interact-shared/incidents";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { PlatformConfigurationFailure } from "../platform-configuration/errors.js";
import { WhatsAppServiceError } from "../whatsapp.service.js";

const environment = resolveDeploymentEnvironmentName();
const logger = createLogger({ serviceName: "moda-messaging-worker", environment });

/** A deterministic occurrence UUID: concurrent reports for the same command cannot inflate counts. */
function commandOccurrenceId(commandId: string, reasonCode: string): string {
  const hex = createHash("sha256").update(`arch040-human-send-incident:${commandId}:${reasonCode}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Never store stacks, provider bodies, request content, credentials or arbitrary error objects. */
export function safeHumanSendErrorMessage(error: unknown, deployment: string): string {
  if (error instanceof PlatformConfigurationFailure) {
    // Error.message, key and code are constants from our own typed configuration adapter.
    return `PlatformConfigurationFailure: ${error.message} (key=${error.key}; code=${error.code})`.slice(0, 512);
  }
  if (error instanceof WhatsAppServiceError) {
    // This is a static message, not the Meta response body.
    return `WhatsAppServiceError: ${error.message} (code=${error.code})`.slice(0, 512);
  }
  if (!["test", "development", "local"].includes(deployment)) {
    return "Unexpected provider-dispatch exception; raw message omitted in this environment";
  }
  const name = error instanceof Error ? error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 64) : "NonError";
  const raw = error instanceof Error ? error.message : "Non-Error exception";
  const redacted = raw
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,})\b/g, "[redacted]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|password|secret|authorization))\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s,;]+/gi, "[url redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email redacted]")
    .replace(/\+?\d{10,16}/g, "[number redacted]")
    .replace(/\p{Cc}+/gu, " ")
    .trim();
  return `${name || "Error"}: ${redacted || "No exception message"}`.slice(0, 512);
}

export type HumanSendIncidentSink = {
  record(input: { commandId: string; shopId: string; error: unknown; outcome: "pre_dispatch" | "unknown" | "definitive_failure" }): Promise<void>;
};

/** Infrastructure-only reporter; the producer owns which failures are actionable. */
export function createHumanSendIncidentSink(
  database: OperationalIncidentPrismaClient = prisma as unknown as OperationalIncidentPrismaClient,
  deployment = environment,
): HumanSendIncidentSink {
  const reporter = createOperationalIncidentReporter({
    persistence: createPrismaOperationalIncidentPersistence({ prisma: database }),
    logger,
    notifySupport: false,
  });
  return {
    async record(input) {
      // Known configuration failures are a platform-wide issue; other UNKNOWNs group by shop.
      const configurationError = input.error instanceof PlatformConfigurationFailure ? input.error : null;
      const senderFailure = input.outcome === "pre_dispatch" ||
        configurationError?.key === "messaging.sender";
      const reasonCode = senderFailure
        ? configurationError ? `WHATSAPP_SENDER_${configurationError.code}` : "WHATSAPP_SENDER_PREFLIGHT_FAILED"
        : input.outcome === "unknown" ? "HUMAN_PROVIDER_OUTCOME_UNKNOWN" : "HUMAN_PROVIDER_REJECTED";
      const incident = {
        contractVersion: "operational-incident.v1" as const,
        sourceService: "background", environment: deployment,
        category: "WHATSAPP_HUMAN_SEND", reasonCode,
        resourceKey: senderFailure ? "messaging.sender" : "human-send",
        shopId: senderFailure ? null : input.shopId,
        severity: "HIGH" as const,
        occurrenceId: commandOccurrenceId(input.commandId, reasonCode),
        correlationId: input.commandId,
        occurredAt: new Date().toISOString(),
        errorMessage: safeHumanSendErrorMessage(input.error, deployment),
      };
      const result = await reporter.report(incident);
      if (!result) {
        logger.error("arch040.human_dispatcher.incident_report_failed", {
          commandId: input.commandId, reasonCode,
        });
      }
    },
  };
}
