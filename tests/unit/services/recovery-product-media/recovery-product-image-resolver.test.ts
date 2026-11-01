import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { verifyEncodedBrandImage } from "../../../../src/services/shop-brand-media/metadata-verifier.js";
import { ShopBrandMediaError, type SafeFetcher } from "../../../../src/services/shop-brand-media/contracts.js";
import type { BrandR2Transport } from "../../../../src/services/shop-brand-media/r2-writer.js";
import {
  RecoveryProductImageResolver,
  type OutreachProductImageRequest,
} from "../../../../src/services/recovery-product-media/recovery-product-image-resolver.js";

const sourceUrl = "https://catalog.example.net/current.jpg";
const input: OutreachProductImageRequest = {
  shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt_1",
  generation: 4, productId: "gid://shopify/Product/9", variantId: "gid://shopify/ProductVariant/10",
};
const product = {
  productId: input.productId, variantId: input.variantId, title: "Coat", url: "https://myshop.com/products/coat",
  available: true, unitPrice: "12.00", currency: "GBP", productType: null, vendor: null,
  imageUrl: sourceUrl, saleEvidence: null, observedAt: "2026-10-31T12:00:00.000Z",
};

function fixture(platform: "SHOPIFY" | "WOOCOMMERCE" = "SHOPIFY") {
  const site = platform === "SHOPIFY" ? "myshop.com" : "https://myshop.com/store";
  const state = { generation: 4, site, status: "PENDING", imageUrl: sourceUrl, productId: input.productId,
    variantId: input.variantId, wooStatus: "ACTIVE" };
  const database = {
    shop: { findUnique: vi.fn(async () => ({
      id: "shop-1", domain: state.site, platform, status: "ACTIVE",
      wooCommerceInstallation: platform === "WOOCOMMERCE" ? {
        canonicalSiteUrl: state.site, status: state.wooStatus,
      } : null,
    })) },
    checkoutRecovery: { findUnique: vi.fn(async () => ({
      id: "recovery-1", shopId: "shop-1", generation: state.generation,
    })) },
    recoveryOutreachAttempt: { findUnique: vi.fn(async () => ({
      id: "attempt_1", checkoutRecoveryId: "recovery-1", recipient: "+441234567890", sequence: 1,
      status: state.status, outboundMessageId: null, sentAt: null,
    })) },
  };
  const productResult = () => ({ status: "OK", data: { product: {
    ...product, productId: state.productId, variantId: state.variantId, imageUrl: state.imageUrl,
  } } });
  const selector = {
    connect: vi.fn(async () => undefined),
    tools: vi.fn(async () => []),
    call: vi.fn(async () => productResult()),
    close: vi.fn(async () => undefined),
  };
  let connectionSignal: AbortSignal | undefined;
  const sourceBytes = Buffer.from("trusted-source-bytes");
  const fetched: SafeFetcher = { fetch: vi.fn(async () => ({ bytes: sourceBytes, declaredContentType: "image/png" })) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const image = { current: undefined as Awaited<ReturnType<typeof verifyEncodedBrandImage>> | undefined };
  const putVerified = vi.fn(async () => undefined);
  const verifyPublic = vi.fn(async () => undefined);
  const transport: BrandR2Transport = { head: vi.fn(), put: vi.fn() };
  const resolver = new RecoveryProductImageResolver({
    database: database as never,
    selectorFactory: ({ signal }) => { connectionSignal = signal; return selector as never; },
    readPublicMedia: async () => ({ publicOrigin: "https://media.modainteract.com/", bucketName: "public-media" }) as never,
    readR2: async () => ({ endpoint: "https://account.r2.cloudflarestorage.com", accessKeyId: "access", secretAccessKey: "secret" }) as never,
    fetcher: fetched,
    transformer: { transform: async () => image.current! },
    writerFactory: () => ({ putVerified }),
    transportFactory: () => transport,
    probeFactory: () => ({ verify: verifyPublic }),
    clock: () => new Date("2026-10-31T23:59:59.999Z"),
    logger,
  });
  return { resolver, state, database, selector, sourceBytes, fetched, image, putVerified, verifyPublic, logger, transport,
    get connectionSignal() { return connectionSignal; } };
}

describe("RecoveryProductImageResolver", () => {
  it.each(["SHOPIFY", "WOOCOMMERCE"] as const)("resolves exact current product and trusted %s identity", async (platform) => {
    const f = fixture(platform);
    f.image.current = await verifyEncodedBrandImage(await sharp({ create: {
      width: 32, height: 20, channels: 3, background: "#e33",
    } }).resize(1125, 600).jpeg().toBuffer(), "image/jpeg");
    const prepared = await f.resolver.prepareForBinding(input);
    expect(prepared.result.kind).toBe("READY");
    if (prepared.result.kind !== "READY") return;
    expect(prepared.result).toMatchObject({
      shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt_1",
      productId: input.productId, variantId: input.variantId,
      objectKey: expect.stringMatching(/^outreach-products\/(shopify|woocommerce)\/myshop\.com(?:-store)?\/2026\/10\/31\/attempt_1\//),
      width: 1125, height: 600, contentType: "image/jpeg",
      preparedAt: new Date("2026-10-31T23:59:59.999Z"),
    });
    expect(f.selector.call).toHaveBeenCalledWith("commerce_get_product", {
      productId: input.productId, variantId: input.variantId,
    }, expect.any(AbortSignal));
    expect(f.fetched.fetch).toHaveBeenCalledWith(sourceUrl, expect.any(AbortSignal));
    expect(f.putVerified).toHaveBeenCalledWith(expect.objectContaining({
      bucket: "public-media", objectKey: prepared.result.objectKey, image: f.image.current,
      signal: expect.any(AbortSignal),
    }));
    expect(f.verifyPublic).toHaveBeenCalledWith(expect.objectContaining({
      url: prepared.result.publicImageUrl, image: f.image.current,
    }), expect.any(AbortSignal));
    expect(await prepared.validateBeforeBinding()).toBe(true);
  });

  it("keeps the Woo installation path and rejects a mismatched or inactive installation", async () => {
    const f = fixture("WOOCOMMERCE");
    f.image.current = await verifyEncodedBrandImage(await sharp({ create: {
      width: 20, height: 20, channels: 3, background: "#ddd",
    } }).resize(1125, 600).jpeg().toBuffer(), "image/jpeg");
    const ready = await f.resolver.resolve(input);
    expect(ready.kind).toBe("READY");
    if (ready.kind === "READY") expect(ready.objectKey).toContain("/myshop.com-store/2026/");
    f.state.wooStatus = "REVOKED";
    const unavailable = await f.resolver.resolve(input);
    expect(unavailable).toEqual({ kind: "UNAVAILABLE", reason: "MERCHANT_IDENTITY_UNAVAILABLE" });
    expect(f.selector.call).toHaveBeenCalledTimes(1);
  });

  it("rejects stale generations, changed attempts and changed source product identities", async () => {
    const f = fixture();
    f.image.current = await verifyEncodedBrandImage(await sharp({ create: {
      width: 20, height: 20, channels: 3, background: "#ddd",
    } }).resize(1125, 600).jpeg().toBuffer(), "image/jpeg");
    f.state.generation += 1;
    expect(await f.resolver.resolve(input)).toEqual({ kind: "UNAVAILABLE", reason: "ATTEMPT_MISMATCH" });
    f.state.generation = 4;
    f.state.productId = "different-product";
    expect(await f.resolver.resolve(input)).toEqual({ kind: "UNAVAILABLE", reason: "PRODUCT_IDENTITY_MISMATCH" });
    expect(f.putVerified).not.toHaveBeenCalled();
  });

  it("re-fetches image identity on every run and treats a revoked source image as unavailable", async () => {
    const f = fixture();
    f.image.current = await verifyEncodedBrandImage(await sharp({ create: {
      width: 20, height: 20, channels: 3, background: "#ddd",
    } }).resize(1125, 600).jpeg().toBuffer(), "image/jpeg");
    const first = await f.resolver.resolve(input);
    expect(first.kind).toBe("READY");
    f.state.imageUrl = null as never;
    const second = await f.resolver.resolve(input);
    expect(second).toEqual({ kind: "UNAVAILABLE", reason: "PRODUCT_IMAGE_UNAVAILABLE" });
    expect(f.selector.call).toHaveBeenCalledTimes(2);
    expect(f.fetched.fetch).toHaveBeenCalledTimes(1);
  });

  it("revalidates recipient/generation immediately before IMAGE binding", async () => {
    const f = fixture();
    f.image.current = await verifyEncodedBrandImage(await sharp({ create: {
      width: 20, height: 20, channels: 3, background: "#ddd",
    } }).resize(1125, 600).jpeg().toBuffer(), "image/jpeg");
    const prepared = await f.resolver.prepareForBinding(input);
    expect(prepared.result.kind).toBe("READY");
    f.state.generation = 5;
    expect(await prepared.validateBeforeBinding()).toBe(false);
  });

  it("aborts the MCP operation at the 30 second overall preparation deadline", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let markCallStarted!: () => void;
      const callStarted = new Promise<void>((resolve) => { markCallStarted = resolve; });
      f.selector.call.mockImplementation(() => {
        markCallStarted();
        return new Promise((_resolve, reject) => {
          f.connectionSignal!.addEventListener("abort", () => reject(f.connectionSignal!.reason), { once: true });
        }) as never;
      });
      const pending = f.resolver.resolve(input);
      await callStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toEqual({ kind: "UNAVAILABLE", reason: "PRODUCT_IMAGE_UNAVAILABLE" });
      expect(f.connectionSignal?.aborted).toBe(true);
      expect(f.fetched.fetch).not.toHaveBeenCalled();
      expect(f.putVerified).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs bounded redacted source diagnostics and never logs raw source URLs or recipient data", async () => {
    const f = fixture();
    f.fetched.fetch = vi.fn(async () => {
      throw new ShopBrandMediaError("SOURCE_UNAVAILABLE", false,
        `failed ${sourceUrl} token=private bearer abcdefgh1234567890 +441234567890 alice@example.com`);
    }) as never;
    const result = await f.resolver.resolve(input);
    expect(result).toEqual({ kind: "UNAVAILABLE", reason: "PRODUCT_IMAGE_UNAVAILABLE" });
    const text = JSON.stringify(f.logger.warn.mock.calls);
    expect(text).toContain("SOURCE_UNAVAILABLE");
    expect(text).toContain("[URL REDACTED]");
    expect(text).not.toContain(sourceUrl);
    expect(text).not.toContain("private");
    expect(text).not.toContain("abcdefgh1234567890");
    expect(text).not.toContain("+441234567890");
    expect(text).not.toContain("alice@example.com");
  });
});
