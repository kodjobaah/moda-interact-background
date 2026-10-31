import {
  CommerceOutreachToolContextSchema,
  CommerceToolOutputs,
  CommerceToolResultSchema,
} from "@modainteract/moda-interact-shared/commerce";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import {
  compareObservedLinePrices,
  deriveCheckoutPriceReconciliation,
  fingerprintRecoveryPricingBasket,
} from "./price-comparison.js";
import type {
  CheckoutPriceReconciliation,
  ExactProductReader,
  LinePriceObservation,
  PriceReconciliationInput,
  RecoveryPricingState,
  TrustedRecoveryAttemptReader,
} from "./checkout-price-reconciliation.types.js";

const MAX_LINES = 100;
const MAX_CONCURRENCY = 4;
const READ_BUDGET_MS = 20_000;
const MAX_SOURCE_ERROR_TEXT_LENGTH = 512;
const MAX_PROVIDER_ERROR_PAYLOAD_BYTES = 4096;
const MAX_PROVIDER_ERROR_PAYLOAD_NODES = 32;
const MAX_PROVIDER_ERROR_PAYLOAD_DEPTH = 4;
const MAX_PROVIDER_ERROR_PAYLOAD_ITEMS = 8;
const MAX_PROVIDER_ERROR_PAYLOAD_STRING_LENGTH = 192;
const ACTIVE_RECOVERY_STATUSES = new Set(["DETECTED"]);
const ACTIVE_ATTEMPT_STATUSES = new Set(["PENDING", "CAPACITY_BLOCKED"]);
const PROVIDER_ERROR_PAYLOAD_KEYS = new Set([
  "message", "code", "type", "error_subcode", "subcode", "status", "status_code",
  "error_data", "details", "errors", "error", "reason", "field", "fields",
  "request_id", "trace_id", "fbtrace_id", "provider_request_id", "error_user_title",
  "error_user_msg", "user_title", "user_msg", "category", "retryable",
]);

type PriceReconciliationLogger = Pick<StructuredLogger, "error">;
type Product = NonNullable<ReturnType<typeof CommerceToolOutputs.commerce_get_product.parse>["product"]>;
type CatalogueRead =
  | { kind: "product"; product: Product }
  | { kind: "unavailable"; reasonCode: string; sourceCode?: string };
type PreparedLine = Readonly<{
  lineKey: string;
  productId: string | null;
  variantId: string | null;
  quantity: number | null;
  checkoutUnitPrice: string | null;
  checkoutCurrency: string | null;
  initialReasons: readonly string[];
  requestKey: string | null;
}>;
type ProductRequest = Readonly<{
  key: string;
  productId: string;
  variantId: string | null;
  lineKeys: string[];
}>;
type TimerHandle = ReturnType<typeof setTimeout>;

const defaultLogger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export class InvalidPriceReconciliationAttemptError extends Error {
  readonly code = "INVALID_ATTEMPT";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "InvalidPriceReconciliationAttemptError";
  }
}

export type CheckoutPriceReconciliationServiceDependencies = Readonly<{
  recoveryAttemptReader: TrustedRecoveryAttemptReader;
  productReader: ExactProductReader;
  environment?: string;
  now?: () => Date;
  logger?: PriceReconciliationLogger;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}>;

function safeId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : null;
}

function safePrice(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function safeQuantity(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Price reconciliation was cancelled");
}

function redactSourceErrorText(value: string): Readonly<{
  value: string;
  redactionApplied: boolean;
  truncated: boolean;
}> {
  if (/^\s*(?:\{|\[|<html\b|<!doctype\s+html)/i.test(value)) {
    return { value: "[REDACTED_PAYLOAD]", redactionApplied: true, truncated: false };
  }
  const payloadMarker = /\b(?:response|error)?\s*(?:body|payload)\s*[:=]\s*/i.exec(value);
  const objectPayload = /\s+\{(?=["'][^"']+["']\s*:)/.exec(value);
  const payloadStart = payloadMarker?.index ?? objectPayload?.index;
  const withoutPayload = payloadStart === undefined
    ? value
    : `${value.slice(0, payloadStart)} [REDACTED_PAYLOAD]`;
  const scrubbed = withoutPayload
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, "[REDACTED_URL]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(authorization|access[_ -]?token|refresh[_ -]?token|api[_ -]?key|client[_ -]?secret|password|passwd|secret|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/(?<![A-Za-z0-9])\+?\d(?:[\s().-]*\d){6,14}(?![A-Za-z0-9])/g, (candidate) => {
      const digitCount = candidate.replace(/\D/g, "").length;
      return digitCount >= 7 && digitCount <= 15 ? "[REDACTED]" : candidate;
    });
  const truncated = scrubbed.length > MAX_SOURCE_ERROR_TEXT_LENGTH;
  return {
    value: truncated
      ? `${scrubbed.slice(0, MAX_SOURCE_ERROR_TEXT_LENGTH)}[TRUNCATED]`
      : scrubbed,
    redactionApplied: scrubbed !== value,
    truncated,
  };
}

type PayloadSanitizationState = { remainingNodes: number; redactionApplied: boolean; truncated: boolean };

function sanitizeProviderErrorPayload(
  value: unknown,
  state: PayloadSanitizationState,
  depth = 0,
): unknown {
  if (state.remainingNodes <= 0 || depth > MAX_PROVIDER_ERROR_PAYLOAD_DEPTH) {
    state.truncated = true;
    return "[TRUNCATED]";
  }
  state.remainingNodes--;
  if (typeof value === "string") {
    const boundedInput = value.length > MAX_PROVIDER_ERROR_PAYLOAD_STRING_LENGTH * 4
      ? value.slice(0, MAX_PROVIDER_ERROR_PAYLOAD_STRING_LENGTH * 4)
      : value;
    if (boundedInput.length < value.length) state.truncated = true;
    const safeText = redactSourceErrorText(boundedInput);
    const truncated = safeText.value.length > MAX_PROVIDER_ERROR_PAYLOAD_STRING_LENGTH;
    state.redactionApplied ||= safeText.redactionApplied;
    state.truncated ||= safeText.truncated || truncated;
    return truncated
      ? `${safeText.value.slice(0, MAX_PROVIDER_ERROR_PAYLOAD_STRING_LENGTH)}[TRUNCATED]`
      : safeText.value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : "[REDACTED]";
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_PROVIDER_ERROR_PAYLOAD_ITEMS);
    if (value.length > items.length) state.truncated = true;
    return items.map((item) => sanitizeProviderErrorPayload(item, state, depth + 1));
  }
  const object = objectRecord(value);
  if (!object) {
    state.redactionApplied = true;
    return "[REDACTED]";
  }
  const result: Record<string, unknown> = {};
  let scannedKeys = 0;
  for (const key in object) {
    if (!Object.hasOwn(object, key)) continue;
    if (scannedKeys >= MAX_PROVIDER_ERROR_PAYLOAD_ITEMS) {
      state.truncated = true;
      break;
    }
    scannedKeys++;
    if (key.length > 64) {
      state.redactionApplied = true;
      continue;
    }
    const item = object[key];
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!PROVIDER_ERROR_PAYLOAD_KEYS.has(key.toLowerCase()) ||
        /email|phone|address|customer|recipient|token|secret|password|authorization|cookie|url|description|coupon|prompt|header|body|success/.test(normalizedKey)) {
      state.redactionApplied = true;
      continue;
    }
    if (Object.keys(result).length >= MAX_PROVIDER_ERROR_PAYLOAD_ITEMS) {
      state.truncated = true;
      break;
    }
    result[key] = sanitizeProviderErrorPayload(item, state, depth + 1);
  }
  return result;
}

function sourceErrorPayload(error: unknown): unknown {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  const source = error as Record<string, unknown>;
  return source.providerErrorPayload ?? source.providerError ?? source.error_data ?? source.errorData ??
    source.error ?? source.details ?? source.responseBody ?? source.body ?? source.payload;
}

function isProductionEnvironment(environment: string): boolean {
  return /^(?:prod(?:uction)?|live)(?:$|[-_.])/.test(environment);
}

function safeSourceErrorDiagnostic(error: unknown, includePayload: boolean): Readonly<{
  diagnostic: Readonly<Record<string, unknown>>;
  redactionApplied: boolean;
  truncated: boolean;
}> {
  const source = error !== null && (typeof error === "object" || typeof error === "function")
    ? error as Record<string, unknown>
    : null;
  const name = error instanceof Error
    ? error.name
    : typeof source?.name === "string" ? source.name : "NonErrorThrown";
  const message = error instanceof Error
    ? error.message
    : typeof source?.message === "string" ? source.message
      : typeof error === "string" ? error : "[NonErrorSourceFailure]";
  const safeName = redactSourceErrorText(name);
  const safeMessage = redactSourceErrorText(message);
  const diagnostic: Record<string, unknown> = {
    name: safeName.value.slice(0, 128),
    message: safeMessage.value,
  };
  let redactionApplied = safeName.redactionApplied || safeMessage.redactionApplied;
  let truncated = safeName.truncated || safeMessage.truncated || safeName.value.length > 128;
  const status = source?.status ?? source?.statusCode ?? source?.httpStatus;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    diagnostic.status = status;
  }
  const code = source?.code ?? source?.errorCode;
  if (typeof code === "string" || typeof code === "number") {
    const safeCode = redactSourceErrorText(String(code));
    diagnostic.code = safeCode.value.slice(0, 128);
    redactionApplied ||= safeCode.redactionApplied;
    truncated ||= safeCode.truncated || safeCode.value.length > 128;
  }
  if (includePayload) {
    const payload = sourceErrorPayload(error);
    if (payload !== undefined) {
      const state: PayloadSanitizationState = {
        remainingNodes: MAX_PROVIDER_ERROR_PAYLOAD_NODES,
        redactionApplied: false,
        truncated: false,
      };
      const sanitizedPayload = sanitizeProviderErrorPayload(payload, state);
      const serialized = JSON.stringify(sanitizedPayload);
      if (Buffer.byteLength(serialized, "utf8") <= MAX_PROVIDER_ERROR_PAYLOAD_BYTES) {
        diagnostic.providerErrorPayload = sanitizedPayload;
      } else {
        diagnostic.providerErrorPayload = "[TRUNCATED]";
        state.truncated = true;
      }
      redactionApplied ||= state.redactionApplied;
      truncated ||= state.truncated;
    }
  }
  return { diagnostic, redactionApplied, truncated };
}

function waitForAbort(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => { if (onAbort) signal.removeEventListener("abort", onAbort); },
  };
}

class ReadBudgetExceededError extends Error {
  constructor() {
    super("Price reconciliation product-read budget exhausted");
    this.name = "ReadBudgetExceededError";
  }
}

export class CheckoutPriceReconciliationService {
  private readonly now: () => Date;
  private readonly logger: PriceReconciliationLogger;
  private readonly environment: string;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(private readonly dependencies: CheckoutPriceReconciliationServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.logger = dependencies.logger ?? defaultLogger;
    this.environment = (dependencies.environment ?? resolveDeploymentEnvironmentName()).trim().toLowerCase();
    this.setTimer = dependencies.setTimer ?? setTimeout;
    this.clearTimer = dependencies.clearTimer ?? clearTimeout;
  }

  async reconcile(input: PriceReconciliationInput): Promise<CheckoutPriceReconciliation> {
    this.validateInput(input);
    input.signal.throwIfAborted();
    const startedAt = this.now();
    if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) {
      throw new InvalidPriceReconciliationAttemptError("CLOCK_INVALID");
    }
    const evaluatedAt = startedAt.toISOString();
    const initial = await this.readAndValidateState(input, "before_product_reads");
    const recovery = initial.state.recovery;
    const basket = recovery.lineItems;

    if (!Array.isArray(basket) || basket.length === 0) {
      return deriveCheckoutPriceReconciliation({
        shopId: input.shopId,
        checkoutRecoveryId: input.checkoutRecoveryId,
        outreachAttemptId: input.outreachAttemptId,
        generation: input.expectedGeneration,
        basketFingerprint: initial.fingerprint,
        evaluatedAt,
        lines: [],
        reasonCodes: ["BASKET_INVALID"],
      });
    }
    if (basket.length > MAX_LINES) {
      return deriveCheckoutPriceReconciliation({
        shopId: input.shopId,
        checkoutRecoveryId: input.checkoutRecoveryId,
        outreachAttemptId: input.outreachAttemptId,
        generation: input.expectedGeneration,
        basketFingerprint: initial.fingerprint,
        evaluatedAt,
        lines: [],
        reasonCodes: ["BASKET_TOO_LARGE"],
      });
    }

    const preparedLines = basket.map((line, index) => this.prepareLine(
      line,
      index,
      recovery.platform,
      recovery.currency,
    ));
    const requestsByKey = new Map<string, ProductRequest>();
    for (const line of preparedLines) {
      if (!line.requestKey || !line.productId) continue;
      const request = requestsByKey.get(line.requestKey);
      if (request) request.lineKeys.push(line.lineKey);
      else requestsByKey.set(line.requestKey, {
        key: line.requestKey,
        productId: line.productId,
        variantId: line.variantId,
        lineKeys: [line.lineKey],
      });
    }

    const reads = await this.readProducts(input, [...requestsByKey.values()], startedAt.getTime());
    const final = await this.readAndValidateState(input, "after_product_reads");
    if (final.fingerprint !== initial.fingerprint ||
        final.state.recovery.platform !== recovery.platform) {
      throw new InvalidPriceReconciliationAttemptError("RECOVERY_BASKET_CHANGED_DURING_READ");
    }
    input.signal.throwIfAborted();
    if (reads.failure !== undefined) throw reads.failure;

    const lines = preparedLines.map((line) => this.finishLine(line, recovery.platform, reads.outcomes));
    return deriveCheckoutPriceReconciliation({
      shopId: input.shopId,
      checkoutRecoveryId: input.checkoutRecoveryId,
      outreachAttemptId: input.outreachAttemptId,
      generation: input.expectedGeneration,
      basketFingerprint: initial.fingerprint,
      evaluatedAt,
      lines,
    });
  }

  private validateInput(input: PriceReconciliationInput): void {
    if (!input || typeof input.shopId !== "string" || input.shopId.length === 0 ||
        typeof input.checkoutRecoveryId !== "string" || input.checkoutRecoveryId.length === 0 ||
        typeof input.outreachAttemptId !== "string" || input.outreachAttemptId.length === 0 ||
        !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1 ||
        !/^[a-f0-9]{64}$/.test(input.expectedBasketFingerprint) ||
        !(input.signal instanceof AbortSignal)) {
      throw new InvalidPriceReconciliationAttemptError("INPUT_INVALID");
    }
  }

  private async readAndValidateState(
    input: PriceReconciliationInput,
    stage: "before_product_reads" | "after_product_reads",
  ): Promise<{ state: RecoveryPricingState; fingerprint: string }> {
    let state: RecoveryPricingState | null;
    try {
      state = await this.dependencies.recoveryAttemptReader.read({
        shopId: input.shopId,
        checkoutRecoveryId: input.checkoutRecoveryId,
        outreachAttemptId: input.outreachAttemptId,
      });
    } catch (error) {
      this.logFailure(input, {
        stage,
        operation: "trusted_recovery_attempt_read",
        reasonCode: "RECOVERY_STATE_READ_FAILED",
        durationMs: 0,
        affectedLineCount: 0,
        error,
      });
      throw error;
    }
    input.signal.throwIfAborted();
    if (!state || state.recovery.id !== input.checkoutRecoveryId || state.recovery.shopId !== input.shopId ||
        state.recovery.generation !== input.expectedGeneration ||
        !ACTIVE_RECOVERY_STATUSES.has(state.recovery.status) ||
        !state.attempt || state.attempt.id !== input.outreachAttemptId ||
        state.attempt.checkoutRecoveryId !== input.checkoutRecoveryId ||
        state.attempt.sequence !== 1 || state.attempt.trigger !== "INITIAL" ||
        !ACTIVE_ATTEMPT_STATUSES.has(state.attempt.status) || state.attempt.initiatedBy === "HUMAN") {
      throw new InvalidPriceReconciliationAttemptError("RECOVERY_ATTEMPT_LINEAGE_INVALID");
    }
    let fingerprint: string;
    try {
      fingerprint = fingerprintRecoveryPricingBasket({
        shopId: state.recovery.shopId,
        checkoutRecoveryId: state.recovery.id,
        generation: state.recovery.generation,
        currency: state.recovery.currency,
        lineItems: state.recovery.lineItems,
      });
    } catch {
      throw new InvalidPriceReconciliationAttemptError("RECOVERY_BASKET_INVALID");
    }
    if (fingerprint !== input.expectedBasketFingerprint) {
      throw new InvalidPriceReconciliationAttemptError("RECOVERY_BASKET_FINGERPRINT_MISMATCH");
    }
    return { state, fingerprint };
  }

  private prepareLine(
    raw: unknown,
    index: number,
    platform: string,
    currency: string | null,
  ): PreparedLine {
    const line = objectRecord(raw);
    if (!line) throw new InvalidPriceReconciliationAttemptError("RECOVERY_BASKET_INVALID");
    const productId = safeId(line.productId);
    const variantId = safeId(line.variantId);
    const variantIsExplicitNull = line.variantId === null;
    const quantity = safeQuantity(line.quantity);
    const checkoutUnitPrice = safePrice(line.price);
    const checkoutCurrency = typeof currency === "string" ? currency : null;
    const reasons = new Set<string>();
    if (!productId) reasons.add("MISSING_LINE_IDENTITY");
    if (quantity === null) reasons.add("SOURCE_OBSERVATION_INVALID");
    if (variantId === null && !variantIsExplicitNull) reasons.add("SOURCE_OBSERVATION_INVALID");
    if (checkoutUnitPrice === null || checkoutCurrency === null) reasons.add("SNAPSHOT_UNIT_PRICE_UNKNOWN");
    if (platform === "SHOPIFY" && variantId === null) reasons.add("MISSING_VARIANT_ID");
    if (platform !== "SHOPIFY" && platform !== "WOOCOMMERCE") reasons.add("SOURCE_OBSERVATION_INVALID");
    const canRead = productId !== null &&
      (platform === "WOOCOMMERCE"
        ? variantIsExplicitNull || variantId !== null
        : platform === "SHOPIFY" && variantId !== null);
    const requestKey = canRead ? JSON.stringify([productId, variantId]) : null;
    return {
      lineKey: `line-${String(index + 1).padStart(4, "0")}`,
      productId,
      variantId,
      quantity,
      checkoutUnitPrice,
      checkoutCurrency,
      initialReasons: [...reasons],
      requestKey,
    };
  }

  private async readProducts(
    input: PriceReconciliationInput,
    requests: readonly ProductRequest[],
    startedAtMs: number,
  ): Promise<{ outcomes: Map<string, CatalogueRead>; failure?: unknown }> {
    const outcomes = new Map<string, CatalogueRead>();
    if (requests.length === 0) return { outcomes };
    const deadlineController = new AbortController();
    const failureController = new AbortController();
    const readSignal = AbortSignal.any([input.signal, deadlineController.signal, failureController.signal]);
    let timedOut = false;
    let failure: unknown;
    let rejectDeadline!: (error: unknown) => void;
    const deadlineError = new ReadBudgetExceededError();
    const deadlinePromise = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const expire = () => {
      if (timedOut) return;
      timedOut = true;
      deadlineController.abort(deadlineError);
      rejectDeadline(deadlineError);
    };
    const remaining = Math.max(0, READ_BUDGET_MS - (this.now().getTime() - startedAtMs));
    const timer: TimerHandle = this.setTimer(expire, remaining);
    let next = 0;
    const callerAbortError = waitForAbort(input.signal);

    const worker = async () => {
      while (true) {
        if (input.signal.aborted) return;
        if (failure !== undefined) return;
        const request = requests[next++];
        if (!request) return;
        if (timedOut || this.now().getTime() - startedAtMs >= READ_BUDGET_MS) {
          expire();
          outcomes.set(request.key, { kind: "unavailable", reasonCode: "BUDGET_EXHAUSTED" });
          continue;
        }
        const readStartedAt = this.now().getTime();
        const operation = Promise.resolve().then(() => this.dependencies.productReader.read({
          shopId: input.shopId,
          productId: request.productId,
          variantId: request.variantId,
          toolContext: CommerceOutreachToolContextSchema.parse({ purpose: "INITIAL_RECOVERY_OUTREACH" }),
          signal: readSignal,
        }));
        void operation.catch(() => undefined);
        const operationAbort = waitForAbort(readSignal);
        try {
          const raw = await Promise.race([operation, deadlinePromise, callerAbortError.promise, operationAbort.promise]);
          const outcome = this.parseProductResult(raw);
          outcomes.set(request.key, outcome);
          if (outcome.kind === "unavailable") {
            this.logFailure(input, {
              stage: "product_read",
              operation: "commerce_get_product",
              reasonCode: outcome.reasonCode,
              durationMs: Math.max(0, this.now().getTime() - readStartedAt),
              ...(request.lineKeys[0] ? { lineKey: request.lineKeys[0] } : {}),
              affectedLineCount: request.lineKeys.length,
              ...(outcome.sourceCode ? { sourceCode: outcome.sourceCode } : {}),
            });
          }
        } catch (error) {
          if (error === deadlineError || timedOut) {
            outcomes.set(request.key, { kind: "unavailable", reasonCode: "BUDGET_EXHAUSTED" });
            continue;
          }
          if (input.signal.aborted) return;
          if (failure !== undefined) return;
          failure = error;
          failureController.abort(error);
          this.logFailure(input, {
            stage: "product_read",
            operation: "commerce_get_product",
            reasonCode: "PRODUCT_READ_FAILED",
            durationMs: Math.max(0, this.now().getTime() - readStartedAt),
            ...(request.lineKeys[0] ? { lineKey: request.lineKeys[0] } : {}),
            affectedLineCount: request.lineKeys.length,
            error,
          });
          return;
        } finally {
          operationAbort.dispose();
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, requests.length) }, () => worker()));
    } finally {
      this.clearTimer(timer);
      callerAbortError.dispose();
    }
    if (input.signal.aborted) throw abortError(input.signal);
    if (failure !== undefined) return { outcomes, failure };
    return { outcomes };
  }

  private parseProductResult(raw: unknown): CatalogueRead {
    const result = CommerceToolResultSchema.safeParse(raw);
    if (!result.success) return { kind: "unavailable", reasonCode: "SOURCE_OBSERVATION_INVALID" };
    if (result.data.status === "ERROR") {
      return {
        kind: "unavailable",
        reasonCode: "CATALOGUE_PRICE_UNAVAILABLE",
        sourceCode: result.data.code,
      };
    }
    const output = CommerceToolOutputs.commerce_get_product.safeParse(result.data.data);
    if (!output.success) return { kind: "unavailable", reasonCode: "SOURCE_OBSERVATION_INVALID" };
    if (output.data.product === null) return { kind: "unavailable", reasonCode: "CATALOGUE_PRICE_UNAVAILABLE" };
    return { kind: "product", product: output.data.product };
  }

  private finishLine(
    line: PreparedLine,
    platform: string,
    outcomes: ReadonlyMap<string, CatalogueRead>,
  ): LinePriceObservation {
    const reasons = new Set(line.initialReasons);
    let catalogueUnitPrice: string | null = null;
    let catalogueCurrency: string | null = null;
    let catalogueObservedAt: string | null = null;
    if (line.requestKey) {
      const read = outcomes.get(line.requestKey);
      if (!read) {
        reasons.add("CATALOGUE_PRICE_UNAVAILABLE");
      } else if (read.kind === "unavailable") {
        reasons.add(read.reasonCode);
        if (read.reasonCode === "BUDGET_EXHAUSTED") reasons.add("CATALOGUE_PRICE_UNAVAILABLE");
      } else if (read.product.productId !== line.productId || read.product.variantId !== line.variantId) {
        reasons.add("PROVIDER_IDENTITY_MISMATCH");
      } else {
        catalogueUnitPrice = read.product.unitPrice;
        catalogueCurrency = read.product.currency;
        catalogueObservedAt = read.product.observedAt;
        if (catalogueUnitPrice === null || catalogueCurrency === null) reasons.add("CATALOGUE_PRICE_UNAVAILABLE");
      }
    } else if (platform === "SHOPIFY" && line.productId !== null && line.variantId === null) {
      reasons.add("MISSING_VARIANT_ID");
    }

    const comparison = compareObservedLinePrices({
      checkoutUnitPrice: line.checkoutUnitPrice,
      checkoutCurrency: line.checkoutCurrency,
      catalogueUnitPrice,
      catalogueCurrency,
    });
    for (const reasonCode of comparison.reasonCodes) reasons.add(reasonCode);
    const catalogueComparison = line.quantity === null
      ? "INCOMPARABLE"
      : comparison.catalogueComparison;
    return {
      lineKey: line.lineKey,
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
      checkoutUnitPrice: line.checkoutUnitPrice,
      checkoutCurrency: line.checkoutCurrency,
      catalogueUnitPrice,
      catalogueCurrency,
      catalogueObservedAt,
      catalogueComparison,
      checkoutPriceChange: "UNVERIFIABLE",
      reasonCodes: [...reasons],
    };
  }

  private logFailure(input: PriceReconciliationInput, details: Readonly<{
    stage: string;
    operation: string;
    reasonCode: string;
    durationMs: number;
    affectedLineCount: number;
    lineKey?: string;
    sourceCode?: string;
    error?: unknown;
  }>): void {
    try {
      this.logger.error("recovery.price_reconciliation.source_failed", {
        shopId: input.shopId,
        checkoutRecoveryId: input.checkoutRecoveryId,
        outreachAttemptId: input.outreachAttemptId,
        generation: input.expectedGeneration,
        stage: details.stage,
        operation: details.operation,
        reasonCode: details.reasonCode,
        durationMs: details.durationMs,
        affectedLineCount: details.affectedLineCount,
        ...(details.lineKey ? { lineKey: details.lineKey } : {}),
        ...(details.sourceCode ? { sourceCode: details.sourceCode } : {}),
        ...(details.error === undefined ? {} : (() => {
          const safeError = safeSourceErrorDiagnostic(details.error, !isProductionEnvironment(this.environment));
          return {
            sourceError: safeError.diagnostic,
            redactionApplied: safeError.redactionApplied,
            ...(safeError.truncated ? { truncated: true } : {}),
          };
        })()),
      });
    } catch {
      // Logging must not alter source failures or reconciliation results.
    }
  }
}