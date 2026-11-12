import { createLogger, sanitizeLogFields, LOG_VALUE_LIMITS, REDACTED, TRUNCATED, MAX_DEPTH_REACHED, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { platformConsumerConfiguration } from "./platform-configuration/consumers.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import type {
  SendMessageResult,
  SendTemplateInput,
  SendTextInput,
  SendImageInput,
} from "../integration/whatsapp/types.js";

export const DEFAULT_WHATSAPP_API_BASE_URL =
  "https://graph.facebook.com/v25.0";
export const WHATSAPP_SEND_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_ERROR_TEXT_LENGTH = 512;
const MAX_PROVIDER_ERROR_DETAIL_ITEMS = 8;

const defaultLogger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

type FetchImplementation = typeof fetch;

export type WhatsAppServiceErrorCode =
  | "configuration-missing"
  | "provider-rejected"
  | "invalid-provider-response"
  | "invalid-template-input";

export type ModaWhatsAppSender = {
  providerAccountId: string;
  providerPhoneNumberId: string;
};

export class WhatsAppServiceError extends Error {
  constructor(
    readonly code: WhatsAppServiceErrorCode,
    message: string,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = "WhatsAppServiceError";
  }
}

export class WhatsAppService {
  constructor(
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly logger: Pick<StructuredLogger, "error"> & Partial<Pick<StructuredLogger, "info">> = defaultLogger,
  ) {}

  /** Validate encrypted sender credentials before a HUMAN dispatch permit is committed.
   * The provider send still reads the latest credentials independently.
   */
  async assertOutboundSenderConfigured(): Promise<void> {
    const { value } = await platformConsumerConfiguration.read("messaging.sender");
    if (![value.accessToken, value.phoneNumberId, value.businessAccountId]
      .every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
      throw new WhatsAppServiceError("configuration-missing", "WhatsApp configuration is missing");
    }
  }

  async resolveSender(): Promise<ModaWhatsAppSender> {
    const value = (await platformConsumerConfiguration.read("messaging.sender")).value;
    if (!value.businessAccountId || !value.phoneNumberId) {
      throw new WhatsAppServiceError("configuration-missing", "WhatsApp configuration is missing");
    }
    return { providerAccountId: value.businessAccountId, providerPhoneNumberId: value.phoneNumberId };
  }

  async getProviderAccountId(): Promise<string> {
    return (await this.resolveSender()).providerAccountId;
  }

  async sendWhatsAppText({
    to,
    text,
    previewUrl,
    replyToProviderMessageId,
  }: SendTextInput, signal?: AbortSignal): Promise<SendMessageResult> {
    const { value: senderConfig } = await platformConsumerConfiguration.read("messaging.sender");
    const accessToken = senderConfig.accessToken;
    const sender = { providerAccountId: senderConfig.businessAccountId, providerPhoneNumberId: senderConfig.phoneNumberId };
    if (!accessToken?.trim()) {
      throw new WhatsAppServiceError(
        "configuration-missing",
        "WhatsApp configuration is missing",
      );
    }

    const apiBaseUrl = (
      process.env.WHATSAPP_API_BASE_URL?.trim() ||
      DEFAULT_WHATSAPP_API_BASE_URL
    ).replace(/\/+$/, "");

    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${apiBaseUrl}/${sender.providerPhoneNumberId}/messages`,
        {
        method: "POST",

        headers: {
          Authorization: `Bearer ${accessToken}`,

          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          messaging_product: "whatsapp",

          to,

          type: "text",

          ...(replyToProviderMessageId
            ? { context: { message_id: replyToProviderMessageId } }
            : {}),
          text: {
            body: text,
            ...(previewUrl ? { preview_url: true } : {}),
          },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(WHATSAPP_SEND_TIMEOUT_MS)]) : AbortSignal.timeout(WHATSAPP_SEND_TIMEOUT_MS),
        },
      );
    } catch (error) {
      this.logSdkFailure("sendWhatsAppText", error, [accessToken, to, text]);
      throw error;
    }

    // A definitive HTTP rejection remains definitive even if Meta's body is not JSON.
    // A successful response with invalid JSON remains an uncertain send result.
    const body = await this.readProviderResponse("sendWhatsAppText", response, [accessToken, to, text]);

    if (!response.ok) {
      this.logProviderFailure("sendWhatsAppText", response, body, [accessToken, to, text]);
      throw new WhatsAppServiceError(
        "provider-rejected",
        "WhatsApp provider rejected the message",
        extractProviderCode(body),
      );
    }

    const providerMessageId = readProviderMessageId(body);

    if (!providerMessageId) {
      throw new WhatsAppServiceError(
        "invalid-provider-response",
        "WhatsApp response did not contain a message id",
      );
    }

    return {
      providerMessageId,
    };
  }

  async sendWhatsAppImage({
    to,
    link,
    caption,
    replyToProviderMessageId,
  }: SendImageInput, signal?: AbortSignal): Promise<SendMessageResult> {
    const { value: senderConfig } = await platformConsumerConfiguration.read("messaging.sender");
    const accessToken = senderConfig.accessToken;
    const sender = { providerAccountId: senderConfig.businessAccountId, providerPhoneNumberId: senderConfig.phoneNumberId };
    if (!accessToken?.trim()) {
      throw new WhatsAppServiceError(
        "configuration-missing",
        "WhatsApp configuration is missing",
      );
    }

    const apiBaseUrl = (
      process.env.WHATSAPP_API_BASE_URL?.trim() ||
      DEFAULT_WHATSAPP_API_BASE_URL
    ).replace(/\/+$/, "");

    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${apiBaseUrl}/${sender.providerPhoneNumberId}/messages`,
        {
        method: "POST",

        headers: {
          Authorization: `Bearer ${accessToken}`,

          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          messaging_product: "whatsapp",

          to,

          type: "image",

          ...(replyToProviderMessageId
            ? { context: { message_id: replyToProviderMessageId } }
            : {}),
          image: { link, caption },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(WHATSAPP_SEND_TIMEOUT_MS)]) : AbortSignal.timeout(WHATSAPP_SEND_TIMEOUT_MS),
        },
      );
    } catch (error) {
      this.logSdkFailure("sendWhatsAppImage", error, [accessToken, to, link, caption ?? ""]);
      throw error;
    }

    // A definitive HTTP rejection remains definitive even if Meta's body is not JSON.
    // A successful response with invalid JSON remains an uncertain send result.
    const body = await this.readProviderResponse("sendWhatsAppImage", response, [accessToken, to, link, caption ?? ""]);

    if (!response.ok) {
      this.logProviderFailure("sendWhatsAppImage", response, body, [accessToken, to, link, caption ?? ""]);
      throw new WhatsAppServiceError(
        "provider-rejected",
        "WhatsApp provider rejected the message",
        extractProviderCode(body),
      );
    }

    const providerMessageId = readProviderMessageId(body);

    if (!providerMessageId) {
      throw new WhatsAppServiceError(
        "invalid-provider-response",
        "WhatsApp response did not contain a message id",
      );
    }

    return {
      providerMessageId,
    };
  }

  async sendWhatsAppTemplate({
    to,
    templateName,
    languageCode,
    bodyParameters = [],
    textHeader,
    imageHeader,
    dynamicUrlButton,
    dynamicUrlButtons,
  }: SendTemplateInput): Promise<SendMessageResult> {
    const { value: senderConfig } = await platformConsumerConfiguration.read("messaging.sender");
    const accessToken = senderConfig.accessToken;
    const sender = { providerAccountId: senderConfig.businessAccountId, providerPhoneNumberId: senderConfig.phoneNumberId };
    if (!accessToken?.trim()) {
      throw new WhatsAppServiceError(
        "configuration-missing",
        "WhatsApp configuration is missing",
      );
    }

    const apiBaseUrl = (
      process.env.WHATSAPP_API_BASE_URL?.trim() ||
      DEFAULT_WHATSAPP_API_BASE_URL
    ).replace(/\/+$/, "");

    const urlButtons = dynamicUrlButtons ?? (dynamicUrlButton ? [dynamicUrlButton] : []);
    const buttonIndexes = urlButtons.map(({ index }) => index);
    if (urlButtons.some(({ index, text }) => !Number.isSafeInteger(index) || index < 0 || !text.trim()) ||
        new Set(buttonIndexes).size !== buttonIndexes.length) {
      throw new WhatsAppServiceError("invalid-template-input", "WhatsApp template URL buttons are invalid");
    }

    const components = [
      ...(textHeader
        ? [{ type: "header", parameters: [{ type: "text", text: textHeader }] }]
        : []),
      ...(imageHeader
        ? [{
            type: "header",
            parameters: [{ type: "image", image: { link: imageHeader.link } }],
          }]
        : []),
      ...(bodyParameters.length > 0
        ? [{
            type: "body",
            parameters: bodyParameters.map((text) => ({ type: "text", text })),
          }]
        : []),
      ...urlButtons.map((button) => ({
            type: "button",
            sub_type: "url",
            index: String(button.index),
            parameters: [{ type: "text", text: button.text }],
          })),
    ];
    const template = {
      name: templateName,
      language: { code: languageCode },
      ...(components.length > 0 ? { components } : {}),
    };

    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${apiBaseUrl}/${sender.providerPhoneNumberId}/messages`,
        {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "template",
          template,
        }),
        signal: AbortSignal.timeout(WHATSAPP_SEND_TIMEOUT_MS),
        },
      );
    } catch (error) {
      this.logSdkFailure("sendWhatsAppTemplate", error, [accessToken, to, ...bodyParameters, textHeader ?? "", imageHeader?.link ?? "", ...urlButtons.map(({ text }) => text)]);
      throw error;
    }

    // A definitive HTTP rejection remains definitive even if Meta's body is not JSON.
    // A successful response with invalid JSON remains an uncertain send result.
    const body = await this.readProviderResponse("sendWhatsAppTemplate", response, [accessToken, to, ...bodyParameters, textHeader ?? "", imageHeader?.link ?? "", ...urlButtons.map(({ text }) => text)]);
    if (!response.ok) {
      this.logProviderFailure("sendWhatsAppTemplate", response, body, [accessToken, to, ...bodyParameters, textHeader ?? "", imageHeader?.link ?? "", ...urlButtons.map(({ text }) => text)]);
      throw new WhatsAppServiceError(
        "provider-rejected",
        "WhatsApp provider rejected the template",
        extractProviderCode(body),
      );
    }

    const providerMessageId = readProviderMessageId(body);
    if (!providerMessageId) {
      throw new WhatsAppServiceError(
        "invalid-provider-response",
        "WhatsApp response did not contain a message id",
      );
    }

    return { providerMessageId };
  }

  private async readProviderResponse(operation: string, response: Response, privateValues: string[]): Promise<unknown> {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      this.logProviderResponse(operation, response, null, "UNREADABLE", privateValues);
      if (response.ok) throw error;
      return null;
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch (error) {
      this.logProviderResponse(operation, response, text, "TEXT", privateValues);
      // A 2xx response with invalid JSON remains uncertain; do not make it a
      // definitive provider rejection that could trigger a duplicate send.
      if (response.ok) throw error;
      return text || null;
    }
    this.logProviderResponse(operation, response, body, "JSON", privateValues);
    return body;
  }

  private logProviderResponse(
    operation: string, response: Response, body: unknown,
    responseFormat: "JSON" | "TEXT" | "UNREADABLE", privateValues: string[],
  ): void {
    try {
      // Shared owns generic bounds/redaction. Meta-specific filtering additionally
      // removes contact identifiers and any request values echoed by the provider.
      const filtered = safeMetaResponse(body, privateValues);
      const bounded = sanitizeLogFields({ responseBody: filtered.value }).responseBody;
      const safe = safeMetaResponse(bounded, []);
      safe.redactionApplied ||= filtered.redactionApplied;
      safe.truncated ||= filtered.truncated;
      const fields: Record<string, unknown> = {
        origin: "provider_response", provider: "meta", operation,
        httpStatus: response.status,
        outcome: response.ok ? "HTTP_ACCEPTED" : "HTTP_REJECTED",
        deliveryConfirmed: false,
        responseFormat, responseBody: safe.value,
        redactionApplied: safe.redactionApplied,
        truncated: safe.truncated,
      };
      const messageId = readProviderMessageId(safe.value);
      if (messageId) fields.providerMessageId = messageId;
      const requestId = safeProviderIdentifier(response.headers.get("x-fb-request-id") ??
        response.headers.get("x-fb-trace-id") ?? readProviderError(body)?.traceId);
      if (requestId) {
        const safeRequestId = safeMetaResponse(requestId, privateValues);
        if (!safeRequestId.redactionApplied) fields.providerRequestId = safeRequestId.value;
        else fields.redactionApplied = true;
      }
      this.logger.info?.("whatsapp.meta.send.response", fields);
    } catch { /* Observability must never alter sending or retry semantics. */ }
  }

  private logProviderFailure(operation: string, response: Response, body: unknown, privateValues: string[]): void {
    try {
      const filtered = safeMetaResponse(body, privateValues);
      body = filtered.value;
      const providerError = readProviderError(body);
      const fields: Record<string, unknown> = {
        origin: "provider_response",
        provider: "meta",
        operation,
        reasonCode: "META_SEND_FAILED",
        httpStatus: response.status,
        redactionApplied: filtered.redactionApplied, truncated: filtered.truncated,
      };
      const requestId = safeProviderIdentifier(
        response.headers.get("x-fb-request-id") ?? response.headers.get("x-fb-trace-id") ??
        providerError?.traceId,
      );
      if (requestId) {
          const safeRequestId = safeMetaResponse(requestId, privateValues);
          if (!safeRequestId.redactionApplied) fields.providerRequestId = safeRequestId.value;
          else fields.redactionApplied = true;
        }
      if (providerError) {
        const error: Record<string, unknown> = {};
        if (providerError.message !== undefined) {
          const safe = safeProviderText(providerError.message);
          error.message = safe.value;
          fields.redactionApplied = fields.redactionApplied === true || safe.redactionApplied;
          fields.truncated = fields.truncated === true || safe.truncated;
        }
        if (providerError.code !== undefined) error.code = providerError.code;
        if (providerError.subcode !== undefined) error.error_subcode = providerError.subcode;
        if (providerError.errorData !== undefined) {
          const safe = safeProviderDetails(providerError.errorData);
          error.error_data = safe.value;
          fields.redactionApplied = fields.redactionApplied === true || safe.redactionApplied;
          fields.truncated = fields.truncated === true || safe.truncated;
        }
        if (providerError.traceId) error.fbtrace_id = providerError.traceId;
        if (Object.keys(error).length) fields.providerError = error;
      } else if (typeof body === "string" && body.length > 0) {
        const safe = safeProviderText(body);
        fields.providerErrorBody = safe.value;
        fields.redactionApplied = fields.redactionApplied === true || safe.redactionApplied;
        fields.truncated = fields.truncated === true || safe.truncated;
      }
      this.emitFailure(fields);
    } catch { /* Logging must not alter provider rejection semantics. */ }
  }

  private logSdkFailure(operation: string, error: unknown, privateValues: string[]): void {
    const chain: Array<{ name: string; message: string }> = [];
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
      const source = current instanceof Error ? current : null;
      const message = source?.message ?? (typeof current === "string" ? current : "[REDACTED]");
      const safeName = safeProviderText(source?.name ?? "NonErrorThrown", 96);
      const safeMessage = safeProviderText(String(safeMetaResponse(message, privateValues).value));
      chain.push({ name: safeName.value, message: safeMessage.value });
      current = source?.cause;
    }
    this.emitFailure({
      origin: "sdk_exception",
      provider: "meta",
      operation,
      reasonCode: "META_SEND_FAILED",
      sourceError: chain[0],
      ...(chain.length > 1 ? { causeChain: chain.slice(1) } : {}),
      redactionApplied: chain.some((entry) => entry.message.includes("[REDACTED]")),
      truncated: chain.some((entry) => entry.message.includes("[TRUNCATED]")),
    });
  }

  private emitFailure(fields: Record<string, unknown>): void {
    try { this.logger.error("whatsapp.meta.send.failed", fields); } catch { /* Logging must not alter provider outcomes. */ }
  }
}

type MetaProviderError = Readonly<{
  message?: string;
  code?: string | number;
  subcode?: string | number;
  errorData?: unknown;
  traceId?: string;
}>;

function readProviderMessageId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return undefined;
  const first = body.messages[0] as unknown;
  if (typeof first !== "object" || first === null || !("id" in first)) return undefined;
  return typeof first.id === "string" && first.id.length > 0 ? first.id : undefined;
}

/** Semantic Meta response projection; generic recursion limits are Shared-owned. */
function safeMetaResponse(value: unknown, privateValues: string[], depth = 0): {
  value: unknown; redactionApplied: boolean; truncated: boolean;
} {
  if (depth > LOG_VALUE_LIMITS.maxDepth) return { value: MAX_DEPTH_REACHED, redactionApplied: false, truncated: true };
  let redactionApplied = value === REDACTED;
  let truncated = value === TRUNCATED || value === MAX_DEPTH_REACHED;
  if (typeof value === "string") {
    let redacted = value;
    const [credential, ...requestValues] = privateValues;
    if (credential && redacted.includes(credential)) {
      redacted = redacted.replaceAll(credential, REDACTED);
      redactionApplied = true;
    }
    for (const privateValue of requestValues.filter(Boolean)) {
      // Short template values (for example quantity "1") are not unique private
      // spans. Replacing them inside opaque Meta IDs would destroy correlation.
      if (redacted === privateValue || (privateValue.length >= 8 && redacted.includes(privateValue))) {
        redacted = redacted.replaceAll(privateValue, REDACTED);
        redactionApplied = true;
      }
    }
    const safe = safeProviderText(redacted, LOG_VALUE_LIMITS.maxStringLength);
    return { value: safe.value, redactionApplied: redactionApplied || safe.redactionApplied,
      truncated: truncated || safe.truncated };
  }
  if (Array.isArray(value)) {
    const result = value.slice(0, LOG_VALUE_LIMITS.maxArrayItems).map((item) => {
      const safe = safeMetaResponse(item, privateValues, depth + 1);
      redactionApplied ||= safe.redactionApplied;
      truncated ||= safe.truncated;
      return safe.value;
    });
    if (value.length > result.length) truncated = true;
    return { value: result, redactionApplied, truncated };
  }
  if (typeof value !== "object" || value === null) return { value, redactionApplied, truncated };
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, LOG_VALUE_LIMITS.maxObjectKeys)) {
    const safeKey = safeMetaResponse(key, privateValues.slice(0, 1), depth + 1);
    redactionApplied ||= safeKey.redactionApplied;
    truncated ||= safeKey.truncated;
    if (/token|secret|password|authorization|cookie|email|phone|address|customer|recipient|url|header|prompt|coupon/i.test(key) ||
        /^(input|wa_id|to|from|name|first_name|last_name|text|body|caption|parameters)$/i.test(key)) {
      result[String(safeKey.value)] = REDACTED;
      redactionApplied = true;
      continue;
    }
    if (key === "fbtrace_id" && safeProviderIdentifier(typeof item === "string" ? item : undefined) === undefined) {
      result[String(safeKey.value)] = REDACTED;
      redactionApplied = true;
      continue;
    }
    const safe = safeMetaResponse(item, privateValues, depth + 1);
    result[String(safeKey.value)] = safe.value;
    redactionApplied ||= safe.redactionApplied;
    truncated ||= safe.truncated;
  }
  if (entries.length > LOG_VALUE_LIMITS.maxObjectKeys) truncated = true;
  return { value: result, redactionApplied, truncated };
}

function readProviderError(body: unknown): MetaProviderError | null {
  if (typeof body !== "object" || body === null || !("error" in body) ||
      typeof body.error !== "object" || body.error === null) return null;
  const error = body.error as Record<string, unknown>;
  const message = typeof error.message === "string" ? error.message : undefined;
  const code = safeErrorCode(error.code);
  const subcode = safeErrorCode(error.error_subcode);
  const traceId = safeProviderIdentifier(typeof error.fbtrace_id === "string" ? error.fbtrace_id : undefined);
  return {
    ...(message === undefined ? {} : { message }),
    ...(code === undefined ? {} : { code }),
    ...(subcode === undefined ? {} : { subcode }),
    ...(error.error_data === undefined ? {} : { errorData: error.error_data }),
    ...(traceId === undefined ? {} : { traceId }),
  };
}

function safeErrorCode(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)) return value;
  return undefined;
}

function safeProviderIdentifier(value: string | undefined | null): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function safeProviderText(value: string, maximum = MAX_PROVIDER_ERROR_TEXT_LENGTH): {
  value: string; redactionApplied: boolean; truncated: boolean;
} {
  let redactionApplied = false;
  const redacted = value.replace(/[\r\n\t]+/g, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, () => { redactionApplied = true; return "[REDACTED]"; })
    .replace(/\bBearer\s+[^\s,;]+/gi, () => { redactionApplied = true; return "Bearer [REDACTED]"; })
    .replace(/\b(?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|client[_ -]?secret|password|passwd|secret|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      (match) => { redactionApplied = true; return `${match.split(/[:=]/, 1)[0]}=[REDACTED]`; })
    .replace(/(?:https?:\/\/|www\.)[^\s<>"']+/gi, () => { redactionApplied = true; return "[REDACTED_URL]"; })
    .replace(/(?<![A-Za-z0-9])\+?\d(?:[\s().-]*\d){6,14}(?![A-Za-z0-9])/g,
      () => { redactionApplied = true; return "[REDACTED]"; });
  const truncated = redacted.length > maximum;
  return { value: truncated ? `${redacted.slice(0, maximum)}[TRUNCATED]` : redacted, redactionApplied, truncated };
}

function safeProviderDetails(value: unknown, depth = 0, state = { redactionApplied: false, truncated: false }): {
  value: unknown; redactionApplied: boolean; truncated: boolean;
} {
  if (depth > 3) return { value: "[TRUNCATED]", redactionApplied: true, truncated: true };
  if (typeof value === "string") {
    const safe = safeProviderText(value, 192);
    return { ...safe };
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { value, redactionApplied: false, truncated: false };
  }
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_PROVIDER_ERROR_DETAIL_ITEMS).map((item) => {
      const child = safeProviderDetails(item, depth + 1, state);
      state.redactionApplied ||= child.redactionApplied;
      state.truncated ||= child.truncated;
      return child.value;
    });
    if (value.length > result.length) state.truncated = true;
    return { value: result, ...state };
  }
  if (typeof value !== "object") return { value: "[REDACTED]", redactionApplied: true, truncated: false };
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_PROVIDER_ERROR_DETAIL_ITEMS)) {
    if (/token|secret|password|authorization|cookie|email|phone|address|customer|recipient|url|header|body|prompt|coupon/i.test(key)) {
      state.redactionApplied = true;
      continue;
    }
    if (key === "fbtrace_id") {
      const trace = safeProviderIdentifier(typeof item === "string" ? item : undefined);
      if (trace === undefined) state.redactionApplied = true;
      else result[key] = trace;
      continue;
    }
    const safe = safeProviderDetails(item, depth + 1, state);
    result[key.slice(0, 64)] = safe.value;
    state.redactionApplied ||= safe.redactionApplied;
    state.truncated ||= safe.truncated;
  }
  if (Object.keys(value).length > MAX_PROVIDER_ERROR_DETAIL_ITEMS) state.truncated = true;
  return { value: result, ...state };
}

function extractProviderCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body) ||
      typeof body.error !== "object" || body.error === null) return undefined;
  const providerCode = (body.error as { code?: unknown }).code;
  if (typeof providerCode === "number" && Number.isSafeInteger(providerCode) && providerCode >= 0) {
    return String(providerCode);
  }
  if (typeof providerCode === "string" && /^[0-9]{1,32}$/.test(providerCode)) {
    return providerCode;
  }
  return undefined;
}

export const whatsAppService = new WhatsAppService();
