import type { PrismaClient } from "@prisma/client";
import {
  OpenRouterModelClient,
  type OpenRouterModelClientOptions,
} from "@modainteract/moda-interact-shared/commerce/model/node";
import type {
  CommerceEnvironment,
  ResolvedCommerceModel,
} from "@modainteract/moda-interact-shared/commerce/model";
import {
  CommerceModelInvocationFailure,
  type CommerceModelInvoker,
} from "@modainteract/moda-interact-shared/commerce/runner";
import type { LogFields, StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import {
  resolveProductionCommerceModel,
  type ResolvedProductionCommerceModel,
} from "./model-resolution.js";
import { OpenRouterCredentialResolutionFailure } from "./openrouter-credential-failure.js";
import type { OpenRouterCredentialResolver } from "./openrouter-credential.js";

export type ProductionOpenRouterModelFactory = (
  options: OpenRouterModelClientOptions,
) => CommerceModelInvoker;

export type ProductionCommerceModelInvoker = CommerceModelInvoker & {
  readonly selection: Pick<
    ResolvedProductionCommerceModel,
    "selectionSource" | "selectionShopId" | "merchantPricingPlanId" | "shopifyPlanHandle"
  >;
};

function safeModelLog(
  logger: StructuredLogger | undefined,
  event: string,
  fields: LogFields,
): void {
  try {
    logger?.warn(event, fields);
  } catch {
    // An injected logging sink must not alter Commerce execution.
  }
}

function cancelled(logger: StructuredLogger | undefined, fields: LogFields): Error {
  safeModelLog(logger, "commerce.model.operation_aborted", {
    ...fields,
    stage: "model.invoke",
    reasonCode: "MODEL_OPERATION_SIGNAL_ABORTED",
    reasonMessage: "The model invocation stopped because its AbortSignal was triggered.",
    operatorAction: "Inspect the runner cancellation and deadline events to identify the source.",
  });
  // The runner's existing AbortSignal handling remains authoritative for CANCELLED/DEADLINE.
  return new Error("Commerce model invocation failed");
}

type SafeSourceText = Readonly<{ value: string; redacted: boolean; truncated: boolean }>;

function safeSourceText(value: string, maximum = 512, secrets: readonly string[] = []): SafeSourceText {
  let scrubbed = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, "[REDACTED_URL]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|client[_ -]?secret|password|passwd|secret|credential)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[REDACTED]")
    .replace(/(?<![A-Za-z0-9])\+?\d(?:[\s().-]*\d){6,14}(?![A-Za-z0-9])/g, "[REDACTED]");
  for (const secret of secrets) {
    if (secret.length >= 6) scrubbed = scrubbed.split(secret).join("[REDACTED]");
  }
  const truncated = scrubbed.length > maximum;
  return { value: truncated ? `${scrubbed.slice(0, maximum)}[TRUNCATED]` : scrubbed,
    redacted: scrubbed !== value, truncated };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function responseObject(error: unknown): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 5 && current !== null && !seen.has(current); depth += 1) {
    seen.add(current);
    const record = current instanceof Error
      ? current as Error & Record<string, unknown>
      : plainRecord(current);
    if (!record) break;
    const response = plainRecord(record.response);
    const body = plainRecord(response?.data) ?? plainRecord(record.body) ?? plainRecord(record.error);
    if (body) return body;
    current = record.cause;
  }
  return null;
}

function boundedDetails(value: unknown, depth = 0, secrets: readonly string[] = []): { value: unknown; redacted: boolean; truncated: boolean } {
  if (depth > 4) return { value: "[TRUNCATED]", redacted: false, truncated: true };
  if (typeof value === "string") {
    const safe = safeSourceText(value, 192, secrets);
    return { value: safe.value, redacted: safe.redacted, truncated: safe.truncated };
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return { value: typeof value === "number" && !Number.isFinite(value) ? "[REDACTED]" : value,
      redacted: typeof value === "number" && !Number.isFinite(value), truncated: false };
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 8).map((item) => boundedDetails(item, depth + 1, secrets));
    return { value: items.map((item) => item.value), redacted: items.some((item) => item.redacted), truncated: value.length > 8 || items.some((item) => item.truncated) };
  }
  const source = plainRecord(value);
  if (!source) return { value: "[REDACTED]", redacted: true, truncated: false };
  const allowed = new Set(["code", "message", "type", "details", "errors", "error_data", "error_subcode", "subcode", "param", "field"]);
  const output: Record<string, unknown> = {};
  let redacted = false;
  let truncated = false;
  for (const [key, child] of Object.entries(source).slice(0, 8)) {
    if (!allowed.has(key.toLowerCase()) || /email|phone|address|customer|token|secret|password|authorization|cookie|url|prompt|header|body|success/.test(key.toLowerCase())) {
      redacted = true;
      continue;
    }
    const safe = boundedDetails(child, depth + 1, secrets);
    output[key] = safe.value;
    redacted ||= safe.redacted;
    truncated ||= safe.truncated;
  }
  return { value: output, redacted, truncated: truncated || Object.keys(source).length > 8 };
}

function sourceFailureFields(
  error: unknown,
  provider: string,
  reasonCode: string,
  secrets: readonly string[],
  exceptionOrigin: "sdk_exception" | "internal",
): LogFields {
  const source = error instanceof Error ? error as Error & Record<string, unknown> : null;
  const body = responseObject(error);
  const response = source ? plainRecord(source.response) : null;
  const statusValue = source?.status ?? source?.statusCode ?? response?.status;
  const httpStatus = typeof statusValue === "number" && Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599
    ? statusValue : undefined;
  const bodyError = body ? plainRecord(body.error) : null;
  const providerMessage = typeof body?.message === "string" ? body.message
    : typeof body?.error === "string" ? body.error
      : typeof bodyError?.message === "string" ? bodyError.message : null;
  const codeValue = bodyError?.code ?? body?.code ?? source?.code;
  const providerCode = typeof codeValue === "string" || typeof codeValue === "number"
    ? String(codeValue).slice(0, 96) : undefined;
  const rawMessage = providerMessage ?? source?.message;
  const safeMessage = typeof rawMessage === "string" ? safeSourceText(rawMessage, 512, secrets) : null;
  const detailsRaw = bodyError?.details ?? body?.details ?? body?.errors ?? body?.error_data;
  const details = detailsRaw === undefined ? null : boundedDetails(detailsRaw, 0, secrets);
  const requestIdValue = source?.requestID ?? source?.requestId ?? source?.request_id ??
    plainRecord(response?.headers)?.["x-request-id"];
  const providerRequestId = typeof requestIdValue === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(requestIdValue)
    ? requestIdValue : undefined;
  const hasProviderResponse = httpStatus !== undefined || body !== null;
  const causeMessages: Array<{ name: string; message: string }> = [];
  const seen = new Set<unknown>();
  let current = error;
  let redacted = safeMessage?.redacted ?? false;
  let truncated = safeMessage?.truncated ?? false;
  for (let depth = 0; depth < 4 && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current);
    const name = safeSourceText(current.name, 96, secrets);
    const message = safeSourceText(current.message, 512, secrets);
    causeMessages.push({ name: name.value, message: message.value });
    redacted ||= name.redacted || message.redacted;
    truncated ||= name.truncated || message.truncated;
    current = current.cause;
  }
  return {
    origin: hasProviderResponse ? "provider_response" : source ? exceptionOrigin : "internal",
    provider,
    operation: "model.invoke",
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(hasProviderResponse && (providerMessage !== null || providerCode !== undefined || details !== null) ? {
      providerError: {
        ...(providerCode === undefined ? {} : { code: providerCode }),
        ...(safeMessage === null ? {} : { message: safeMessage.value }),
        ...(details === null ? {} : { details: details.value }),
      },
    } : {}),
    ...(!hasProviderResponse && causeMessages.length > 0
      ? exceptionOrigin === "internal"
        ? { internalError: causeMessages[0], causeChain: causeMessages.slice(1) }
        : { sdkError: causeMessages[0], causeChain: causeMessages.slice(1) }
      : {}),
    reasonCode,
    redactionApplied: redacted || details?.redacted === true,
    truncated: truncated || details?.truncated === true,
  };
}

function logInvocationFailure(
  logger: StructuredLogger | undefined,
  fields: LogFields,
  failure: CommerceModelInvocationFailure,
  provider: string,
  secrets: readonly string[],
  exceptionOrigin: "sdk_exception" | "internal",
): void {
  safeModelLog(logger, "commerce.model.invocation_failed", {
    ...fields,
    ...failure.diagnostic,
    ...sourceFailureFields(failure.cause ?? failure, provider, failure.diagnostic.reasonCode, secrets, exceptionOrigin),
  });
}

export async function createProductionCommerceModelInvoker(input: {
  db: PrismaClient;
  environment: CommerceEnvironment;
  shopId: string;
  credentialResolver: OpenRouterCredentialResolver;
  logger?: StructuredLogger;
  conversationId?: string;
  inboundVersion?: number;
  createClient?: ProductionOpenRouterModelFactory;
}): Promise<ProductionCommerceModelInvoker> {
  const correlation = {
    shopId: input.shopId,
    environment: input.environment,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.inboundVersion === undefined ? {} : { inboundVersion: input.inboundVersion }),
  };
  const resolved = await resolveProductionCommerceModel({
    db: input.db,
    environment: input.environment,
    shopId: input.shopId,
  });
  const model: ResolvedCommerceModel = resolved.model;
  const createClient = input.createClient ?? ((options) => new OpenRouterModelClient(options));
  const fields = {
    ...correlation,
    selectionSource: resolved.selectionSource,
    modelProvider: model.provider,
    modelCatalogueEntryId: model.catalogueEntryId,
  };

  return {
    selection: {
      selectionSource: resolved.selectionSource,
      selectionShopId: resolved.selectionShopId,
      merchantPricingPlanId: resolved.merchantPricingPlanId,
      shopifyPlanHandle: resolved.shopifyPlanHandle,
    },
    async invoke(request, signal) {
      if (signal.aborted) throw cancelled(input.logger, fields);
      let credential: string;
      try {
        credential = await input.credentialResolver.resolve({
          environment: input.environment,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw cancelled(input.logger, fields);
        const failure = error instanceof OpenRouterCredentialResolutionFailure
          ? error
          : new OpenRouterCredentialResolutionFailure("CREDENTIAL_RESOLVER_FAILED", error);
        safeModelLog(input.logger, "commerce.model.credential_failed", {
          ...fields,
          stage: failure.stage,
          reasonCode: failure.reasonCode,
          reasonMessage: failure.reasonMessage,
          operatorAction: failure.operatorAction,
        });
        // Shared owns the public diagnostic vocabulary; Background logs the more
        // precise credential failure reason without changing the runner contract.
        throw new CommerceModelInvocationFailure({
          stage: "model.invoke",
          reasonCode: failure.reasonCode === "CREDENTIAL_LOOKUP_FAILED" ||
            failure.reasonCode === "CREDENTIAL_RESOLVER_FAILED"
            ? "MODEL_INVOCATION_FAILED"
            : "MODEL_CREDENTIAL_INVALID",
        }, failure);
      }
      if (signal.aborted) throw cancelled(input.logger, fields);

      let client: CommerceModelInvoker;
      try {
        client = createClient({
          provider: model.provider,
          providerModelId: model.providerModelId,
          configurationSchemaVersion: model.configurationSchemaVersion,
          configuration: model.configuration,
          credential,
          onDiagnostic(diagnostic) {
            // Shared sanitizes codes and constructs fixed safe operator explanations.
            const safe = new CommerceModelInvocationFailure({
              stage: "model.invoke",
              reasonCode: diagnostic.reason,
              providerStage: diagnostic.stage,
              ...(diagnostic.statusCode === undefined ? {} : { statusCode: diagnostic.statusCode }),
              ...(diagnostic.providerCode === undefined ? {} : { providerCode: diagnostic.providerCode }),
              ...(diagnostic.transportCode === undefined ? {} : { transportCode: diagnostic.transportCode }),
            }).diagnostic;
            safeModelLog(input.logger, "commerce.model.provider_diagnostic", {
              ...fields,
              ...safe,
            });
          },
        });
      } catch (error) {
        if (signal.aborted) throw cancelled(input.logger, fields);
        const failure = error instanceof CommerceModelInvocationFailure
          ? error
          : new CommerceModelInvocationFailure({
              stage: "model.invoke",
              reasonCode: "MODEL_ADAPTER_INITIALIZATION_FAILED",
              providerStage: "request",
            }, error);
        logInvocationFailure(input.logger, fields, failure, model.provider, [credential], "internal");
        throw failure;
      }

      try {
        return await client.invoke(request, signal);
      } catch (error) {
        if (signal.aborted) throw cancelled(input.logger, fields);
        const failure = error instanceof CommerceModelInvocationFailure
          ? error
          : new CommerceModelInvocationFailure({
              stage: "model.invoke",
              reasonCode: "MODEL_INVOCATION_FAILED",
            }, error);
        logInvocationFailure(input.logger, fields, failure, model.provider, [credential], "sdk_exception");
        throw failure;
      }
    },
  };
}
