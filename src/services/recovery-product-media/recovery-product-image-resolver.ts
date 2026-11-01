import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { PrismaClient } from "@prisma/client";
import type { infer as Infer } from "zod";
import { CommerceToolOutputs } from "@modainteract/moda-interact-shared/commerce";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { RecoveryOutreachMcpSelectorService } from "../recovery-offers/recovery-outreach-mcp-selector.service.js";
import { CommerceHostError } from "../../commerce/mcp-client.js";
import {
  readR2Configuration,
  readShopBrandPublicMediaConfiguration,
} from "../platform-configuration/consumers.js";
import { ShopBrandMediaError, type SafeFetcher, type VerifiedBrandImage } from "../shop-brand-media/contracts.js";
import { createSafeImageFetcher } from "../shop-brand-media/safe-fetch.js";
import { createShopBrandPublicMediaProbe } from "../shop-brand-media/public-probe.js";
import {
  createBrandR2S3Transport,
  type BrandR2Transport,
} from "../shop-brand-media/r2-writer.js";
import { loadShopBrandR2Credentials } from "../shop-brand-media/r2-config.js";
import { verifiedPublicMediaOrigin } from "../shop-brand-media-runtime/resolver.js";
import {
  createOutreachProductImageTransformer,
  type OutreachProductImageTransformer,
} from "./product-image-transformer.js";
import {
  buildOutreachProductObjectKey,
  isOutreachProductObjectKey,
} from "./outreach-product-object-key.js";
import {
  createOutreachProductR2Writer,
  type OutreachProductR2Writer,
} from "./product-r2-writer.js";
import { normalizeOutreachMerchantSite } from "./merchant-site-segment.js";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const PREPARATION_BUDGET_MS = 30_000;
const ALLOWED_ATTEMPT_STATUSES = new Set(["PENDING", "CAPACITY_BLOCKED"]);
const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export type OutreachProductMediaResult = Readonly<
  | {
      kind: "READY";
      shopId: string;
      checkoutRecoveryId: string;
      outreachAttemptId: string;
      productId: string;
      variantId: string | null;
      objectKey: string;
      publicImageUrl: string;
      contentSha256: string;
      width: 1125;
      height: 600;
      contentType: "image/jpeg";
      preparedAt: Date;
    }
  | {
      kind: "UNAVAILABLE";
      reason:
        | "MERCHANT_IDENTITY_UNAVAILABLE"
        | "ATTEMPT_MISMATCH"
        | "PRODUCT_IDENTITY_MISMATCH"
        | "PRODUCT_IMAGE_UNAVAILABLE"
        | "UNSAFE_IMAGE_SOURCE"
        | "IMAGE_TRANSFORM_FAILED"
        | "R2_UNAVAILABLE"
        | "PUBLIC_IMAGE_UNAVAILABLE";
    }
>;

export type OutreachProductImageRequest = Readonly<{
  shopId: string;
  checkoutRecoveryId: string;
  outreachAttemptId: string;
  generation: number;
  productId: string;
  variantId: string | null;
}>;

export type PreparedOutreachProductMedia = Readonly<{
  result: OutreachProductMediaResult;
  /** Re-check tenant, generation, attempt recipient and source identity just before frozen header binding. */
  validateBeforeBinding(): Promise<boolean>;
}>;

type MediaDatabase = Pick<PrismaClient,
  "shop" | "checkoutRecovery" | "recoveryOutreachAttempt">;
type CurrentMediaContext = Readonly<{
  shopId: string;
  platform: "SHOPIFY" | "WOOCOMMERCE";
  domain: string;
  merchantSite: string;
  recoveryId: string;
  generation: number;
  attemptId: string;
  recipient: string;
  sequence: number;
  status: string;
}>;
type CurrentMediaContextResult =
  | Readonly<{ kind: "ready"; context: CurrentMediaContext }>
  | Readonly<{ kind: "unavailable"; reason: "MERCHANT_IDENTITY_UNAVAILABLE" | "ATTEMPT_MISMATCH" }>;
type ProductReader = Pick<RecoveryOutreachMcpSelectorService, "connect" | "tools" | "call" | "close">;

export type OutreachProductImageResolverDependencies = Readonly<{
  database?: MediaDatabase;
  selectorFactory?: (input: { shopId: string; signal: AbortSignal }) => ProductReader;
  readPublicMedia?: typeof readShopBrandPublicMediaConfiguration;
  readR2?: typeof readR2Configuration;
  fetcher?: SafeFetcher;
  transformer?: OutreachProductImageTransformer;
  writerFactory?: (transport: BrandR2Transport) => OutreachProductR2Writer;
  transportFactory?: (configuration: unknown) => BrandR2Transport;
  probeFactory?: (fetcher: SafeFetcher) => { verify(input: { url: string; image: VerifiedBrandImage }, signal?: AbortSignal): Promise<void> };
  clock?: () => Date;
  monotonicNow?: () => number;
  logger?: Pick<StructuredLogger, "warn" | "error" | "info">;
}>;

class ExpectedMediaUnavailable extends Error {
  constructor(readonly reason: Extract<OutreachProductMediaResult, { kind: "UNAVAILABLE" }>['reason'],
    readonly providerStage: string, readonly providerDiagnostic?: string) {
    super(reason);
    this.name = "ExpectedMediaUnavailable";
  }
}
class PreparationDeadlineExceeded extends Error {
  constructor() { super("PRODUCT_IMAGE_PREPARATION_DEADLINE"); this.name = "PreparationDeadlineExceeded"; }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function validProviderId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value.trim() === value && ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    });
}
function safeDiagnosticText(value: string): string {
  return [...value].map((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("")
    .replace(/\bhttps?:\/\/[^\s,;]+/gi, "[URL REDACTED]")
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/((?:access.?key(?:.?id)?|secret.?key|session.?token|security.?token|token|password|signature|credential|api.?key)\s*[:=]\s*)[^\s,;&"'<>]+/gi, "$1[REDACTED]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[EMAIL REDACTED]")
    .replace(/\b(?:\+?\d[\d ().-]{7,}\d)\b/g, "[PHONE REDACTED]")
    .replace(/\s+/g, " ").trim().slice(0, 300);
}
function safeErrorChain(error: unknown): readonly Readonly<{ name: string; message: string }>[] {
  const chain: Array<{ name: string; message: string }> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof ExpectedMediaUnavailable) {
      chain.push({ name: current.name,
        message: safeDiagnosticText(current.providerDiagnostic ?? current.message) });
      current = undefined;
    } else if (current instanceof ShopBrandMediaError) {
      chain.push({ name: `${current.name}:${current.code}`,
        message: safeDiagnosticText(current.providerMessage ?? current.message) });
      current = "cause" in current ? current.cause : undefined;
    } else if (current instanceof Error) {
      chain.push({ name: current.name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "Error",
        message: safeDiagnosticText(current.message) });
      current = current.cause;
    } else if (typeof current === "string") {
      chain.push({ name: "Error", message: safeDiagnosticText(current) });
      current = undefined;
    } else if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      chain.push({
        name: typeof record.name === "string" ? record.name.slice(0, 80) : "Error",
        message: safeDiagnosticText(typeof record.message === "string" ? record.message : "provider_failure"),
      });
      current = record.cause;
    } else current = undefined;
  }
  return chain;
}
function unavailable(reason: Extract<OutreachProductMediaResult, { kind: "UNAVAILABLE" }>['reason']): OutreachProductMediaResult {
  return { kind: "UNAVAILABLE", reason };
}
function sameContext(left: CurrentMediaContext, right: CurrentMediaContext): boolean {
  return left.shopId === right.shopId && left.platform === right.platform &&
    left.domain === right.domain && left.merchantSite === right.merchantSite &&
    left.recoveryId === right.recoveryId && left.generation === right.generation &&
    left.attemptId === right.attemptId && left.recipient === right.recipient &&
    left.sequence === right.sequence && left.status === right.status;
}

export class RecoveryProductImageResolver {
  private readonly database: MediaDatabase;
  private readonly selectorFactory: NonNullable<OutreachProductImageResolverDependencies["selectorFactory"]>;
  private readonly readPublicMedia: NonNullable<OutreachProductImageResolverDependencies["readPublicMedia"]>;
  private readonly readR2: NonNullable<OutreachProductImageResolverDependencies["readR2"]>;
  private readonly fetcher: SafeFetcher;
  private readonly transformer: OutreachProductImageTransformer;
  private readonly writerFactory: NonNullable<OutreachProductImageResolverDependencies["writerFactory"]>;
  private readonly transportFactory: NonNullable<OutreachProductImageResolverDependencies["transportFactory"]>;
  private readonly probeFactory: NonNullable<OutreachProductImageResolverDependencies["probeFactory"]>;
  private readonly clock: () => Date;
  private readonly monotonicNow: () => number;
  private readonly log: NonNullable<OutreachProductImageResolverDependencies["logger"]>;

  constructor(dependencies: OutreachProductImageResolverDependencies = {}) {
    this.database = dependencies.database ?? prisma;
    this.selectorFactory = dependencies.selectorFactory ??
      ((input) => new RecoveryOutreachMcpSelectorService(input));
    this.readPublicMedia = dependencies.readPublicMedia ?? readShopBrandPublicMediaConfiguration;
    this.readR2 = dependencies.readR2 ?? readR2Configuration;
    this.fetcher = dependencies.fetcher ?? createSafeImageFetcher({ maxBytes: MAX_SOURCE_BYTES });
    this.transformer = dependencies.transformer ?? createOutreachProductImageTransformer();
    this.writerFactory = dependencies.writerFactory ?? createOutreachProductR2Writer;
    this.transportFactory = dependencies.transportFactory ?? ((configuration) =>
      createBrandR2S3Transport(loadShopBrandR2Credentials(configuration as never)));
    this.probeFactory = dependencies.probeFactory ?? ((safeFetcher) => createShopBrandPublicMediaProbe(safeFetcher));
    this.clock = dependencies.clock ?? (() => new Date());
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    this.log = dependencies.logger ?? logger;
  }

  async resolve(input: OutreachProductImageRequest): Promise<OutreachProductMediaResult> {
    return (await this.prepareForBinding(input)).result;
  }

  async prepareForBinding(input: OutreachProductImageRequest): Promise<PreparedOutreachProductMedia> {
    const started = this.monotonicNow();
    const abortController = new AbortController();
    let timeoutReject: ((error: Error) => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timeoutReject = reject; });
    const timeoutId = setTimeout(() => {
      abortController.abort(new PreparationDeadlineExceeded());
      timeoutReject?.(new PreparationDeadlineExceeded());
    }, PREPARATION_BUDGET_MS);
    const state: {
      stage: string;
      context?: CurrentMediaContext;
      preparedAt?: Date;
      objectKey?: string;
      sourceProductHash?: string;
      contentSha256?: string;
      image?: VerifiedBrandImage;
    } = { stage: "IDENTITY" };
    const report = (result: "READY" | "UNAVAILABLE", reason?: string, error?: unknown, timeoutHit = false) => {
      const context = state.context;
      const fields = {
        shopId: input?.shopId ?? "unknown",
        recoveryId: input?.checkoutRecoveryId ?? "unknown",
        attemptId: input?.outreachAttemptId ?? "unknown",
        platform: context?.platform.toLowerCase() ?? "unknown",
        merchantNamespace: context?.merchantSite ?? null,
        objectKey: state.objectKey ?? null,
        sourceProductHash: state.sourceProductHash ?? null,
        outputHash: state.contentSha256 ?? null,
        preparedAtUtcDay: state.preparedAt?.toISOString().slice(0, 10) ?? null,
        sourceStage: state.stage,
        width: state.image?.width ?? null,
        height: state.image?.height ?? null,
        bytes: state.image?.sizeBytes ?? null,
        result,
        ...(reason ? { reasonCode: reason } : {}),
        ...(timeoutHit ? { timeoutDiagnostic: "TOTAL_MEDIA_PREPARATION_BUDGET_EXCEEDED" } : {}),
        durationMs: Math.max(0, Math.round(this.monotonicNow() - started)),
        ...(error !== undefined ? { diagnostics: safeErrorChain(error) } : {}),
      };
      if (result === "READY") this.log.info("recovery_product_media.ready", fields);
      else this.log.warn("recovery_product_media.unavailable", fields);
    };

    try {
      const result = await Promise.race([this.resolveWithinBudget(input, abortController.signal, state), timeout]);
      clearTimeout(timeoutId);
      if (result.result.kind === "READY") {
        report("READY");
        return result;
      }
      report("UNAVAILABLE", result.result.reason);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof PreparationDeadlineExceeded) {
        const result = unavailable("PRODUCT_IMAGE_UNAVAILABLE");
        report("UNAVAILABLE", "PRODUCT_IMAGE_UNAVAILABLE", error, true);
        return { result, validateBeforeBinding: async () => false };
      }
      if (error instanceof ExpectedMediaUnavailable) {
        const result = unavailable(error.reason);
        report("UNAVAILABLE", error.reason, error);
        return { result, validateBeforeBinding: async () => false };
      }
      if (error instanceof ShopBrandMediaError) {
        const reason = this.reasonFor(error, state.stage);
        const result = unavailable(reason);
        report("UNAVAILABLE", reason, error);
        return { result, validateBeforeBinding: async () => false };
      }
      this.log.error("recovery_product_media.failed", {
        shopId: input?.shopId ?? "unknown",
        recoveryId: input?.checkoutRecoveryId ?? "unknown",
        attemptId: input?.outreachAttemptId ?? "unknown",
        sourceStage: state.stage,
        result: "THREW",
        durationMs: Math.max(0, Math.round(this.monotonicNow() - started)),
        diagnostics: safeErrorChain(error),
      });
      throw error;
    }
  }

  private async resolveWithinBudget(
    input: OutreachProductImageRequest,
    signal: AbortSignal,
    state: { stage: string; context?: CurrentMediaContext; preparedAt?: Date; objectKey?: string;
      sourceProductHash?: string; contentSha256?: string; image?: VerifiedBrandImage },
  ): Promise<PreparedOutreachProductMedia> {
    if (!input || !validId(input.shopId) || !validId(input.checkoutRecoveryId) ||
        !validId(input.outreachAttemptId) || !Number.isSafeInteger(input.generation) || input.generation < 1 ||
        !validProviderId(input.productId) ||
        (input.variantId !== null && !validProviderId(input.variantId))) {
      throw new ExpectedMediaUnavailable("PRODUCT_IDENTITY_MISMATCH", "INPUT");
    }

    state.stage = "IDENTITY";
    const currentContext = await this.readCurrentContext(input);
    if (currentContext.kind !== "ready") {
      throw new ExpectedMediaUnavailable(currentContext.reason, "IDENTITY");
    }
    const context = currentContext.context;
    state.context = context;

    state.stage = "MCP_PRODUCT_LOOKUP";
    const product = await this.readCurrentProduct(input, signal);
    if (!product || product.productId !== input.productId || product.variantId !== input.variantId) {
      throw new ExpectedMediaUnavailable("PRODUCT_IDENTITY_MISMATCH", "MCP_PRODUCT_LOOKUP");
    }
    if (!product.imageUrl) throw new ExpectedMediaUnavailable("PRODUCT_IMAGE_UNAVAILABLE", "MCP_PRODUCT_LOOKUP");
    state.sourceProductHash = createHash("sha256")
      .update(`${context.platform.toLowerCase()}\0${product.productId}`, "utf8").digest("hex");

    // One authoritative UTC read, immediately before this attempt-specific image preparation.
    state.preparedAt = this.clock();
    if (!(state.preparedAt instanceof Date) || !Number.isFinite(state.preparedAt.getTime())) {
      throw new ShopBrandMediaError("INVALID_INPUT");
    }
    state.stage = "SOURCE_FETCH";
    const fetched = await this.fetcher.fetch(product.imageUrl, signal);
    if (fetched.bytes.length > MAX_SOURCE_BYTES) throw new ShopBrandMediaError("SOURCE_TOO_LARGE");

    state.stage = "IMAGE_TRANSFORM";
    const image = await this.transformer.transform(fetched.bytes);
    if (image.contentType !== "image/jpeg" || image.width !== 1125 || image.height !== 600 ||
        image.sizeBytes !== image.bytes.length || image.sizeBytes >= MAX_OUTPUT_BYTES) {
      throw new ShopBrandMediaError("OUTPUT_VERIFICATION_FAILED");
    }
    state.image = image;
    state.contentSha256 = image.contentSha256;

    state.stage = "R2_CONFIGURATION";
    let publicConfiguration: Awaited<ReturnType<typeof readShopBrandPublicMediaConfiguration>>;
    let r2Configuration: Awaited<ReturnType<typeof readR2Configuration>>;
    try {
      [publicConfiguration, r2Configuration] = await Promise.all([this.readPublicMedia(), this.readR2()]);
    } catch (error) {
      throw new ShopBrandMediaError("R2_CONFIGURATION_INVALID", false,
        safeErrorChain(error)[0]?.message);
    }
    let origin: URL;
    try { origin = verifiedPublicMediaOrigin(publicConfiguration.publicOrigin); }
    catch (error) {
      throw new ShopBrandMediaError("R2_CONFIGURATION_INVALID", false, safeErrorChain(error)[0]?.message);
    }
    const objectKey = buildOutreachProductObjectKey({
      platform: context.platform,
      merchantSite: context.merchantSite,
      preparedAt: state.preparedAt,
      outreachAttemptId: input.outreachAttemptId,
      providerProductId: product.productId,
      providerVariantId: product.variantId,
      contentSha256: image.contentSha256,
    });
    if (!isOutreachProductObjectKey(objectKey)) throw new ShopBrandMediaError("OUTPUT_VERIFICATION_FAILED");
    state.objectKey = objectKey;

    state.stage = "R2_PUT_HEAD";
    const transport = this.transportFactory(r2Configuration);
    await this.writerFactory(transport).putVerified({
      bucket: publicConfiguration.bucketName,
      objectKey,
      image,
      signal,
    });

    state.stage = "PUBLIC_GET_HASH_PROBE";
    const publicUrl = new URL(objectKey, `${origin.origin}/`);
    if (publicUrl.origin !== origin.origin || publicUrl.search || publicUrl.hash ||
        !publicUrl.pathname.startsWith("/outreach-products/")) {
      throw new ShopBrandMediaError("OUTPUT_VERIFICATION_FAILED");
    }
    const probeFetcher = createSafeImageFetcher({ maxBytes: MAX_OUTPUT_BYTES - 1, maxRedirects: 0 });
    await this.probeFactory(probeFetcher).verify({ url: publicUrl.href, image }, signal);

    state.stage = "FINAL_BINDING_FENCE";
    const finalContext = await this.readCurrentContext(input);
    if (finalContext.kind !== "ready" || !sameContext(context, finalContext.context) ||
        product.productId !== input.productId || product.variantId !== input.variantId) {
      throw new ExpectedMediaUnavailable("ATTEMPT_MISMATCH", "FINAL_BINDING_FENCE");
    }
    const ready: OutreachProductMediaResult = {
      kind: "READY",
      shopId: input.shopId,
      checkoutRecoveryId: input.checkoutRecoveryId,
      outreachAttemptId: input.outreachAttemptId,
      productId: product.productId,
      variantId: product.variantId,
      objectKey,
      publicImageUrl: publicUrl.href,
      contentSha256: image.contentSha256,
      width: 1125,
      height: 600,
      contentType: "image/jpeg",
      preparedAt: state.preparedAt,
    };
    return {
      result: ready,
      validateBeforeBinding: async () => {
        const current = await this.readCurrentContext(input);
        return Boolean(current.kind === "ready" && sameContext(context, current.context) &&
          ready.shopId === input.shopId && ready.checkoutRecoveryId === input.checkoutRecoveryId &&
          ready.outreachAttemptId === input.outreachAttemptId &&
          ready.productId === input.productId && ready.variantId === input.variantId &&
          isOutreachProductObjectKey(ready.objectKey) &&
          ready.publicImageUrl === publicUrl.href && ready.contentSha256 === image.contentSha256);
      },
    };
  }

  private reasonFor(error: ShopBrandMediaError, stage: string): Extract<OutreachProductMediaResult, { kind: "UNAVAILABLE" }>['reason'] {
    if (stage === "SOURCE_FETCH") return error.code === "UNSAFE_SOURCE" || error.code === "DNS_FAILURE" ||
      error.code === "DNS_TEMPORARY_FAILURE" ? "UNSAFE_IMAGE_SOURCE" : "PRODUCT_IMAGE_UNAVAILABLE";
    if (stage === "IMAGE_TRANSFORM") return "IMAGE_TRANSFORM_FAILED";
    if (stage === "R2_CONFIGURATION" || stage === "R2_PUT_HEAD" || error.code.startsWith("R2_")) {
      return "R2_UNAVAILABLE";
    }
    if (stage === "PUBLIC_GET_HASH_PROBE" || error.code.startsWith("PUBLIC_MEDIA_")) {
      return "PUBLIC_IMAGE_UNAVAILABLE";
    }
    if (error.code === "UNSAFE_SOURCE") return "UNSAFE_IMAGE_SOURCE";
    return "PRODUCT_IMAGE_UNAVAILABLE";
  }

  private async readCurrentProduct(input: OutreachProductImageRequest, signal: AbortSignal) {
    const selector = this.selectorFactory({ shopId: input.shopId, signal });
    let primaryError: unknown;
    let productResult: NonNullable<Infer<typeof CommerceToolOutputs.commerce_get_product>["product"]> | undefined;
    try {
      await selector.connect();
      await selector.tools();
      const response = await selector.call("commerce_get_product", {
        productId: input.productId,
        variantId: input.variantId,
      }, signal);
      if (response.status !== "OK") {
        throw new ExpectedMediaUnavailable("PRODUCT_IMAGE_UNAVAILABLE", "MCP_PRODUCT_LOOKUP", response.code);
      }
      const parsed = CommerceToolOutputs.commerce_get_product.safeParse(response.data);
      if (!parsed.success) {
        throw new ExpectedMediaUnavailable("PRODUCT_IMAGE_UNAVAILABLE", "MCP_PRODUCT_LOOKUP", "MCP_OUTPUT_SCHEMA_INVALID");
      }
      const product = parsed.data.product;
      if (!product) throw new ExpectedMediaUnavailable("PRODUCT_IMAGE_UNAVAILABLE", "MCP_PRODUCT_LOOKUP", "MCP_PRODUCT_MISSING");
      if (product.productId !== input.productId || product.variantId !== input.variantId) {
        throw new ExpectedMediaUnavailable("PRODUCT_IDENTITY_MISMATCH", "MCP_PRODUCT_LOOKUP", "EXACT_PRODUCT_IDENTITY_MISMATCH");
      }
      productResult = product;
    } catch (error) {
      primaryError = error instanceof CommerceHostError
        ? new ExpectedMediaUnavailable("PRODUCT_IMAGE_UNAVAILABLE", "MCP_PRODUCT_LOOKUP", error.message)
        : error;
    }
    try { await selector.close(); }
    catch (closeError) {
      if (primaryError !== undefined) {
        this.log.warn("recovery_product_media.mcp_close_failed", {
          shopId: input.shopId,
          recoveryId: input.checkoutRecoveryId,
          attemptId: input.outreachAttemptId,
          sourceStage: "MCP_CLOSE",
          diagnostics: safeErrorChain(closeError),
        });
      } else throw closeError;
    }
    if (primaryError !== undefined) throw primaryError;
    return productResult;
  }

  private async readCurrentContext(input: OutreachProductImageRequest): Promise<CurrentMediaContextResult> {
    const [shop, recovery, attempt] = await Promise.all([
      this.database.shop.findUnique({
        where: { id: input.shopId },
        select: {
          id: true,
          domain: true,
          platform: true,
          status: true,
          wooCommerceInstallation: { select: { canonicalSiteUrl: true, status: true } },
        },
      }),
      this.database.checkoutRecovery.findUnique({
        where: { id: input.checkoutRecoveryId },
        select: { id: true, shopId: true, generation: true },
      }),
      this.database.recoveryOutreachAttempt.findUnique({
        where: { id: input.outreachAttemptId },
        select: {
          id: true, checkoutRecoveryId: true, recipient: true, sequence: true,
          status: true, outboundMessageId: true, sentAt: true,
        },
      }),
    ]);
    if (!shop || shop.id !== input.shopId || shop.status !== "ACTIVE") {
      return { kind: "unavailable", reason: "MERCHANT_IDENTITY_UNAVAILABLE" };
    }
    if (!recovery || recovery.id !== input.checkoutRecoveryId || recovery.shopId !== input.shopId ||
        recovery.generation !== input.generation || !attempt || attempt.id !== input.outreachAttemptId ||
        attempt.checkoutRecoveryId !== input.checkoutRecoveryId || attempt.sequence !== 1 ||
        !attempt.recipient || !ALLOWED_ATTEMPT_STATUSES.has(attempt.status) ||
        attempt.outboundMessageId !== null || attempt.sentAt !== null) {
      return { kind: "unavailable", reason: "ATTEMPT_MISMATCH" };
    }
    if (shop.platform !== "SHOPIFY" && shop.platform !== "WOOCOMMERCE") {
      return { kind: "unavailable", reason: "MERCHANT_IDENTITY_UNAVAILABLE" };
    }
    let trustedSite: string;
    if (shop.platform === "SHOPIFY") trustedSite = shop.domain;
    else {
      const installation = shop.wooCommerceInstallation;
      if (!installation || installation.status !== "ACTIVE" ||
          installation.canonicalSiteUrl !== shop.domain) {
        return { kind: "unavailable", reason: "MERCHANT_IDENTITY_UNAVAILABLE" };
      }
      trustedSite = installation.canonicalSiteUrl;
    }
    const merchantSite = normalizeOutreachMerchantSite(trustedSite);
    if (!merchantSite) return { kind: "unavailable", reason: "MERCHANT_IDENTITY_UNAVAILABLE" };
    return { kind: "ready", context: {
      shopId: shop.id,
      platform: shop.platform,
      domain: shop.domain,
      merchantSite,
      recoveryId: recovery.id,
      generation: recovery.generation,
      attemptId: attempt.id,
      recipient: attempt.recipient,
      sequence: attempt.sequence,
      status: attempt.status,
    } };
  }
}

export function createProductionRecoveryProductImageResolver() {
  return new RecoveryProductImageResolver();
}

export { PREPARATION_BUDGET_MS, MAX_SOURCE_BYTES, MAX_OUTPUT_BYTES };
