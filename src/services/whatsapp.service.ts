import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { platformConsumerConfiguration } from "./platform-configuration/consumers.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import type {
  SendMessageResult,
  SendTemplateInput,
  SendTextInput,
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
    private readonly logger: Pick<StructuredLogger, "error"> = defaultLogger,
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
      this.logSdkFailure("sendWhatsAppText", error);
      throw error;
    }

    // A definitive HTTP rejection remains definitive even if Meta's body is not JSON.
    // A successful response with invalid JSON remains an uncertain send result.
    const body = response.ok ? await response.json() : await rejectedResponseBody(response);

    if (!response.ok) {
      this.logProviderFailure("sendWhatsAppText", response, body);
      throw new WhatsAppServiceError(
        "provider-rejected",
        "WhatsApp provider rejected the message",
        extractProviderCode(body),
      );
    }

    const providerMessageId = body.messages?.[0]?.id;

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
      this.logSdkFailure("sendWhatsAppTemplate", error);
      throw error;
    }

    // A definitive HTTP rejection remains definitive even if Meta's body is not JSON.
    // A successful response with invalid JSON remains an uncertain send result.
    const body = response.ok ? await response.json() : await rejectedResponseBody(response);
    if (!response.ok) {
      this.logProviderFailure("sendWhatsAppTemplate", response, body);
      throw new WhatsAppServiceError(
        "provider-rejected",
        "WhatsApp provider rejected the template",
        extractProviderCode(body),
      );
    }

    const providerMessageId = body.messages?.[0]?.id;
    if (!providerMessageId) {
      throw new WhatsAppServiceError(
        "invalid-provider-response",
        "WhatsApp response did not contain a message id",
      );
    }

    return { providerMessageId };
  }

  private logProviderFailure(operation: string, response: Response, body: unknown): void {
    const providerError = readProviderError(body);
    const fields: Record<string, unknown> = {
      origin: "provider_response",
      provider: "meta",
      operation,
      reasonCode: "META_SEND_FAILED",
      httpStatus: response.status,
    };
    const requestId = safeProviderIdentifier(
      response.headers.get("x-fb-request-id") ?? response.headers.get("x-fb-trace-id") ??
      providerError?.traceId,
    );
    if (requestId) fields.providerRequestId = requestId;
    if (providerError) {
      const error: Record<string, unknown> = {};
      if (providerError.message !== undefined) {
        const safe = safeProviderText(providerError.message);
        error.message = safe.value;
        fields.redactionApplied = safe.redactionApplied;
        fields.truncated = safe.truncated;
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
      fields.redactionApplied = safe.redactionApplied;
      fields.truncated = safe.truncated;
    }
    this.emitFailure(fields);
  }

  private logSdkFailure(operation: string, error: unknown): void {
    const chain: Array<{ name: string; message: string }> = [];
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
      const source = current instanceof Error ? current : null;
      const message = source?.message ?? (typeof current === "string" ? current : "[REDACTED]");
      const safeName = safeProviderText(source?.name ?? "NonErrorThrown", 96);
      const safeMessage = safeProviderText(message);
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

async function rejectedResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function readProviderError(body: unknown): MetaProviderError | null {
  if (typeof body !== "object" || body === null || !("error" in body) ||
      typeof body.error !== "object" || body.error === null) return null;
  const error = body.error as Record<string, unknown>;
  const message = typeof error.message === "string" ? error.message : undefined;
  const code = safeErrorCode(error.code);
  const subcode = safeErrorCode(error.error_subcode);
  const traceId = typeof error.fbtrace_id === "string" ? error.fbtrace_id : undefined;
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
    const result = value.slice(0, MAX_PROVIDER_ERROR_DETAIL_ITEMS).map((item) =>
      safeProviderDetails(item, depth + 1, state).value);
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
