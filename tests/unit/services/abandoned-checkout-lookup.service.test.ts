import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../../src/runtime/deployment-environment.js";

const prismaMock = {
  shop: {
    findUnique: vi.fn(),
  },
};

const getToken = vi.fn(async () => "test-access-token");

vi.mock("../../../src/lib/db.js", () => ({
  default: prismaMock,
}));

vi.mock("../../../src/services/shopify-session.service.js", () => ({
  getShopifyAccessToken: getToken,
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { AbandonedCheckoutLookupService } = await import(
  "../../../src/services/abandoned-checkout-lookup.service.js"
);

const evaluationTime = Date.parse("2026-08-28T12:30:00Z");
const service = new AbandonedCheckoutLookupService(undefined, () => evaluationTime);
const diagnosticRecords: Array<{ event: string; data?: Record<string, unknown> }> = [];
let requestSequence = 0;
const diagnosticService = new AbandonedCheckoutLookupService(
  undefined,
  () => evaluationTime,
  {
    logger: createLogger({
      serviceName: "abandoned-checkout-lookup-test",
      environment: "test",
      sink: (record) => diagnosticRecords.push(record),
    }),
    environment: resolveDeploymentEnvironmentName,
    requestId: () => `request-${++requestSequence}`,
  },
);

const candidate = {
  shopId: "shop_1",
  shopDomain: "shop.myshopify.com",
  checkoutToken: "checkout_1",
  cartToken: "cart_1",
  abandonedCheckoutUrl: "https://shop.myshopify.com/recover?key=abc123",
  checkoutCreatedAt: "2026-08-28T12:00:00Z",
};

const candidateUrl = candidate.abandonedCheckoutUrl!;
const otherUrl = "https://shop.myshopify.com/recover?key=other";

function makeNode(url: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `gid://shopify/AbandonedCheckout/${url === candidateUrl ? "111" : "222"}`,
    abandonedCheckoutUrl: url,
    createdAt: "2026-08-28T12:00:00Z",
    completedAt: null,
    customAttributes: [],
    totalPriceSet: {
      presentmentMoney: { amount: "49.99", currencyCode: "USD" },
    },
    customer: {
      id: "gid://shopify/Customer/999",
      email: "buyer@example.com",
      phone: "+15551234567",
      firstName: "Ada",
      lastName: "Lovelace",
    },
    billingAddress: {
      phone: "+15551234567",
      countryCodeV2: "US",
      timeZone: "America/New_York",
    },
    shippingAddress: { phone: null },
    lineItems: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: "gid://shopify/AbandonedCheckoutLineItem/1",
          product: { id: "gid://shopify/Product/1" },
          variant: { id: "gid://shopify/ProductVariant/1" },
          sku: "SKU-1",
          title: "Teal Dress",
          variantTitle: "M",
          quantity: 2,
          originalUnitPriceSet: {
            presentmentMoney: { amount: "20.00", currencyCode: "USD" },
          },
        },
      ],
    },
    ...overrides,
  };
}

function mockCountResponse(count: number) {
  fetchMock.mockImplementationOnce(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: { abandonedCheckoutsCount: { count } },
    }),
  }));
}

function mockListResponse(nodes: unknown[]) {
  fetchMock.mockImplementationOnce(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: {
        abandonedCheckouts: { nodes },
        shop: { plan: { shopifyPlus: false } },
      },
    }),
  }));
}

describe("abandoned checkout lookup service", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    getToken.mockClear();
    prismaMock.shop.findUnique.mockReset();
    diagnosticRecords.length = 0;
    requestSequence = 0;
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", "test");
    vi.stubEnv("OTEL_DEPLOYMENT_ENVIRONMENT", "");
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns found with normalized checkout on exactly one URL match", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      domain: candidate.shopDomain,
    });
    mockCountResponse(1);
    mockListResponse([makeNode(candidateUrl)]);

    const result = await service.lookup(candidate);

    expect(result.kind).toBe("found");

    if (result.kind === "found") {
      expect(result.checkout.abandonedCheckoutUrl).toBe(candidateUrl);
      expect(result.checkout.totalPrice).toBe("49.99");
      expect(result.checkout.currencyCode).toBe("USD");
      expect(result.checkout.customer?.email).toBe("buyer@example.com");
      expect(result.checkout.lineItems).toHaveLength(1);
      expect(result.checkout.lineItems[0].sku).toBe("SKU-1");
      expect(result.checkout.completedAt).toBeNull();
      expect(result.checkout.shopifyPlus).toBe(false);
      expect(result.checkout.consentReceiptAttribute).toEqual({ kind: "MISSING" });
      expect(result.checkout.billingPhone).toBe("+15551234567");
    }
  });

  it("extracts one consent receipt attribute and marks duplicates or malformed attributes invalid", async () => {
    mockCountResponse(1);
    mockListResponse([makeNode(candidateUrl, {
      customAttributes: [{ key: "moda_wa_consent_v1", value: "v1.receipt" }],
      billingAddress: { phone: "+14155550123", countryCodeV2: "US", timeZone: null },
      shippingAddress: { phone: "+14155550999" },
    })]);
    const single = await service.lookup(candidate);
    expect(single.kind).toBe("found");
    if (single.kind === "found") {
      expect(single.checkout.consentReceiptAttribute).toEqual({ kind: "VALUE", value: "v1.receipt" });
      expect(single.checkout.billingPhone).toBe("+14155550123");
      expect(single.checkout.shippingPhone).toBe("+14155550999");
    }

    mockCountResponse(1);
    mockListResponse([makeNode(candidateUrl, {
      customAttributes: [
        { key: "moda_wa_consent_v1", value: "v1.first" },
        { key: "moda_wa_consent_v1", value: "v1.second" },
      ],
    })]);
    const duplicate = await service.lookup(candidate);
    expect(duplicate.kind).toBe("found");
    if (duplicate.kind === "found") {
      expect(duplicate.checkout.consentReceiptAttribute).toEqual({ kind: "INVALID" });
    }

    mockCountResponse(1);
    mockListResponse([makeNode(candidateUrl, { customAttributes: null })]);
    const absent = await service.lookup(candidate);
    expect(absent.kind).toBe("found");
    if (absent.kind === "found") {
      expect(absent.checkout.consentReceiptAttribute).toEqual({ kind: "MISSING" });
    }
  });

  it("finds a checkout whose abandonment is recorded more than ten minutes after checkout creation", async () => {
    mockCountResponse(1);
    mockListResponse([makeNode(candidateUrl, { createdAt: "2026-08-28T12:21:24Z" })]);
    expect((await service.lookup(candidate)).kind).toBe("found");
    const count = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const list = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(count.variables.query).toBe(list.variables.query);
    expect(list.variables.first).toBe(20);
  });

  it("refuses a truncated basket instead of silently omitting line items", async () => {
    mockCountResponse(1);
    mockListResponse([makeNode(candidateUrl, {
      lineItems: { ...makeNode(candidateUrl).lineItems, pageInfo: { hasNextPage: true } },
    })]);
    await expect(service.lookup(candidate)).rejects.toThrow(/100 line-item lookup bound/);
  });

  it("returns not-found when no abandonedCheckoutUrl matches", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      domain: candidate.shopDomain,
    });
    mockCountResponse(1);
    mockListResponse([makeNode(otherUrl)]);

    const result = await service.lookup(candidate);

    expect(result.kind).toBe("not-found");
  });

  it("returns not-found early when candidate has no abandonedCheckoutUrl", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      domain: candidate.shopDomain,
    });

    const result = await service.lookup({ ...candidate, abandonedCheckoutUrl: null });

    expect(result.kind).toBe("not-found");
    // No Shopify call should be made when there is nothing to match.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ambiguous when multiple abandonedCheckoutUrl match", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      domain: candidate.shopDomain,
    });
    mockCountResponse(2);
    mockListResponse([makeNode(candidateUrl), makeNode(candidateUrl)]);

    const result = await service.lookup(candidate);

    expect(result.kind).toBe("ambiguous");

    if (result.kind === "ambiguous") {
      expect(result.matched).toBe(2);
    }
  });

  it("returns bounded-limit-exceeded before paging when count exceeds the bound", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      domain: candidate.shopDomain,
    });
    mockCountResponse(21);

    const result = await service.lookup(candidate);

    expect(result.kind).toBe("bounded-limit-exceeded");

    if (result.kind === "bounded-limit-exceeded") {
      expect(result.candidateCount).toBe(21);
    }

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.query).toContain("abandonedCheckoutsCount(query: $query, limit: $limit)");
    expect(body.query).not.toContain("maximum");
    expect(body.variables).toMatchObject({ limit: 21 });

    // The bounded list query must never run once the count pre-check fails,
    // proving the implementation cannot enumerate an unbounded history.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps provider errors distinct from not-found", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      domain: candidate.shopDomain,
    });

    const responseText = vi.fn(async () => "server error");
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      text: responseText,
    }));

    await expect(diagnosticService.lookup(candidate)).rejects.toThrow(
      /Shopify abandoned-checkout GraphQL request failed/,
    );
    expect(responseText).toHaveBeenCalledTimes(1);
    expect(diagnosticRecords.find((record) =>
      record.event === "shopify.abandoned_checkout.graphql.provider_failure")?.data)
      .toMatchObject({
        origin: "provider_response",
        httpStatus: 500,
        providerErrorBody: "server error",
      });
  });

  it("throws on GraphQL errors rather than treating them as not-found", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      domain: candidate.shopDomain,
    });

    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ errors: [{ message: "boom" }] }),
    }));

    await expect(service.lookup(candidate)).rejects.toThrow(/GraphQL error/);
  });

  it("includes abandonment recorded after checkout creation while retaining bounded count", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      domain: candidate.shopDomain,
    });
    mockCountResponse(0);

    await service.lookup(candidate);

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    const query = body.variables.query as string;

    expect(query).toMatch(/created_at:>="/);
    expect(query).toMatch(/created_at:<="/);
    expect(query).toBe('created_at:>="2026-08-28T11:50:00.000Z" AND created_at:<="2026-08-28T12:40:00.000Z"');
    // Only one Shopify call: the bounded count pre-check (no list query).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses billing purchaser context instead of shipping destination context", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      domain: candidate.shopDomain,
    });
    mockCountResponse(1);
    mockListResponse([
      makeNode(candidateUrl, {
        totalPriceSet: {
          presentmentMoney: { amount: "49.99", currencyCode: "GBP" },
        },
        customer: {
          ...makeNode(candidateUrl).customer,
          locale: "en-GB",
        },
        shippingAddress: {
          countryCodeV2: "FR",
          timeZone: "Europe/Paris",
        },
        billingAddress: {
          countryCodeV2: "GB",
          timeZone: "Europe/London",
        },
      }),
    ]);

    const result = await service.lookup(candidate);

    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.checkout.internationalContext).toEqual({
        languageTag: "en-GB",
        languageSource: null,
        countryCode: "GB",
        currencyCode: "GBP",
        timeZone: "Europe/London",
      });
      expect(result.checkout.currencyCode).toBe("GBP");
    }
  });

  it("sends a complete 2026-07 list query without shipping or legacy fields", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      domain: candidate.shopDomain,
    });
    mockCountResponse(1);
    mockListResponse([makeNode(candidateUrl)]);

    await service.lookup(candidate);

    const listCall = fetchMock.mock.calls[1];
    const body = JSON.parse(listCall[1].body as string);
    const query = body.query as string;

    expect(query).toContain("lineItems(first: 100)");
    expect(query).toContain("pageInfo { hasNextPage }");
    expect(query).toContain("totalPriceSet");
    expect(query).toContain("presentmentMoney");
    expect(query).toContain("billingAddress");
    expect(query).toContain("locale");
    expect(query).toContain("sku");
    expect(query).toContain("originalUnitPriceSet");
    expect(query).toContain("shippingAddress");
    expect(query).toContain("customAttributes");
    expect(query).toContain("shopifyPlus");
    expect(query.indexOf("shop {")).toBeLessThan(query.indexOf("abandonedCheckouts("));
    expect(query).not.toMatch(/\n {14}currencyCode\s*\n/);
    expect(query).not.toContain("totalPrice {");
    expect(query).not.toContain("originalUnitPrice {");
    expect((query.match(/{/g) ?? []).length).toBe(
      (query.match(/}/g) ?? []).length,
    );
  });

  it("reconstructs synthetic count and detail responses from sanitized ordered chunks", async () => {
    const receipt = `v1.${"opaque-ciphertext-".repeat(90)}`;
    const countResponse = {
      data: { abandonedCheckoutsCount: { count: 4 } },
      extensions: { diagnosticPadding: "count-extension-".repeat(140) },
    };
    const detailResponse = {
      data: {
        shop: { plan: { shopifyPlus: false } },
        abandonedCheckouts: {
          nodes: [
            makeNode(candidateUrl, {
              customAttributes: [{ key: "moda_wa_consent_v1", value: receipt }],
              billingAddress: {
                phone: "+15550102030",
                address1: "123 Synthetic Way",
                city: "Testville",
                countryCodeV2: "US",
                timeZone: "America/New_York",
              },
              lineItems: {
                pageInfo: { hasNextPage: false },
                nodes: Array.from({ length: 30 }, (_, index) => ({
                  id: `gid://shopify/AbandonedCheckoutLineItem/${index}`,
                  product: { id: `gid://shopify/Product/${index}` },
                  variant: { id: `gid://shopify/ProductVariant/${index}` },
                  sku: `SYN-${index}`,
                  title: `Synthetic test product ${index} 🛍️ ${"basket-item-".repeat(12)}`,
                  variantTitle: "Test size",
                  quantity: index + 1,
                  originalUnitPriceSet: {
                    presentmentMoney: { amount: "12.00", currencyCode: "USD" },
                  },
                })),
              },
            }),
            makeNode(otherUrl, { customAttributes: null }),
            makeNode("https://shop.myshopify.com/recover?key=duplicate", {
              customAttributes: [
                { key: "moda_wa_consent_v1", value: "v1.first" },
                { key: "moda_wa_consent_v1", value: "v1.second" },
              ],
            }),
            makeNode("https://shop.myshopify.com/recover?key=missing", {
              customAttributes: undefined,
            }),
          ],
        },
      },
    };
    const countText = JSON.stringify(countResponse);
    const detailText = JSON.stringify(detailResponse);
    const responseText = [countText, detailText];
    let responseIndex = 0;
    fetchMock.mockImplementation(async () => {
      const text = responseText[responseIndex++]!;
      return { ok: true, status: 200, text: vi.fn(async () => text) };
    });

    const result = await diagnosticService.lookup(candidate);

    expect(result.kind).toBe("found");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const chunksFor = (operation: string) => diagnosticRecords
      .filter((record) =>
        record.event === "shopify.abandoned_checkout.graphql.synthetic_response_chunk" &&
        record.data?.operation === operation)
      .sort((left, right) =>
        Number(left.data?.chunkIndex) - Number(right.data?.chunkIndex));

    for (const [operation, expected] of [
      ["AbandonedCheckoutsCount", countText],
      ["AbandonedCheckouts", detailText],
    ] as const) {
      const chunks = chunksFor(operation);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map((record) => record.data?.chunkIndex)).toEqual(
        Array.from({ length: chunks.length }, (_, index) => index),
      );
      expect(chunks.every((record) =>
        record.data?.chunkCount === chunks.length &&
        record.data?.syntheticTestData === true &&
        [...String(record.data?.responseChunk ?? "")].length <= 1024)).toBe(true);
      expect(chunks.map((record) => record.data?.responseChunk).join("")).toBe(expected);
    }

    const detailChunks = chunksFor("AbandonedCheckouts")
      .map((record) => String(record.data?.responseChunk ?? "")).join("");
    expect(detailChunks).toContain("buyer@example.com");
    expect(detailChunks).toContain("+15550102030");
    expect(detailChunks).toContain("123 Synthetic Way");
    expect(detailChunks).toContain(receipt);

    const attributeSummary = diagnosticRecords.find((record) =>
      record.event === "shopify.abandoned_checkout.graphql.receipt_attributes");
    expect(attributeSummary?.data).toMatchObject({
      present: 1,
      missing: 2,
      duplicate: 1,
      invalid: 0,
    });
    expect(diagnosticRecords.find((record) =>
      record.event === "shopify.abandoned_checkout.graphql.count_parsed")?.data)
      .toMatchObject({ candidateCount: 4 });
    expect(diagnosticRecords.find((record) =>
      record.event === "shopify.abandoned_checkout.graphql.details_parsed")?.data)
      .toMatchObject({ nodeCount: 4 });
    expect(diagnosticRecords.every((record) =>
      JSON.stringify(record).includes("test-access-token") === false)).toBe(true);
    expect(diagnosticRecords.filter((record) =>
      record.event === "shopify.abandoned_checkout.graphql.request_started"))
      .toHaveLength(2);
    expect(diagnosticRecords.filter((record) =>
      record.event === "shopify.abandoned_checkout.graphql.request_completed"))
      .toHaveLength(2);
    expect(diagnosticRecords.find((record) =>
      record.event === "shopify.abandoned_checkout.graphql.request_started")?.data)
      .toMatchObject({
        requestId: "request-1",
        shopId: candidate.shopId,
        checkoutDigest: expect.any(String),
        operation: "AbandonedCheckoutsCount",
        queryBounds: { from: expect.any(String), to: expect.any(String), limit: 21, first: null },
      });
  });

  it("marks Shared-redacted response chunks and never emits raw chunks outside test/development", async () => {
    const response = {
      data: { abandonedCheckoutsCount: { count: 0 } },
      diagnosticUrl: "https://shop.myshopify.com/recover?token=private-query-secret",
    };
    const responseText = JSON.stringify(response);
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: async () => responseText,
    }));

    // Render's NODE_ENV is production, but the canonical deployment group is test.
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", "test");
    vi.stubEnv("NODE_ENV", "production");
    await diagnosticService.lookup(candidate);
    const testChunks = diagnosticRecords.filter((record) =>
      record.event === "shopify.abandoned_checkout.graphql.synthetic_response_chunk");
    expect(testChunks).toHaveLength(1);
    expect(testChunks[0]?.data?.syntheticTestData).toBe(true);
    expect(testChunks[0]?.data?.redactionApplied).toBe(true);
    expect(testChunks[0]?.data?.responseChunk).toContain("[REDACTED]");
    expect(JSON.stringify(testChunks)).not.toContain("private-query-secret");
    expect(testChunks.map((record) => record.data?.responseChunk).join(""))
      .not.toBe(responseText);

    for (const environment of ["production", "unknown"]) {
      diagnosticRecords.length = 0;
      fetchMock.mockReset();
      fetchMock.mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        text: async () => responseText,
      }));
      vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", environment);
      await diagnosticService.lookup(candidate);
      expect(diagnosticRecords.some((record) =>
        record.event === "shopify.abandoned_checkout.graphql.synthetic_response_chunk"))
        .toBe(false);
    }
  });

  it("retains original GraphQL errors, paths, extensions and one-query early failure diagnostics", async () => {
    const graphQLErrors = [{
      message: "Access denied for abandonedCheckoutsCount field.",
      locations: [{ line: 2, column: 3 }],
      path: ["abandonedCheckoutsCount"],
      extensions: { code: "ACCESS_DENIED", details: "Original Shopify detail" },
    }];
    const responseText = JSON.stringify({ errors: graphQLErrors });
    const responseTextMock = vi.fn(async () => responseText);
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      text: responseTextMock,
    }));

    await expect(diagnosticService.lookup(candidate)).rejects.toThrow(
      /GraphQL error/,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(responseTextMock).toHaveBeenCalledTimes(1);
    const failure = diagnosticRecords.find((record) =>
      record.event === "shopify.abandoned_checkout.graphql.provider_failure");
    expect(failure?.data).toMatchObject({
      origin: "provider_response",
      provider: "shopify",
      operation: "AbandonedCheckoutsCount",
      httpStatus: 200,
      providerErrors: [{
        message: graphQLErrors[0]?.message,
        path: graphQLErrors[0]?.path,
        locations: graphQLErrors[0]?.locations,
        extensions: graphQLErrors[0]?.extensions,
      }],
    });
    const rawErrors = diagnosticRecords
      .filter((record) =>
        record.event === "shopify.abandoned_checkout.graphql.synthetic_response_chunk" &&
        record.data?.operation === "AbandonedCheckoutsCount")
      .sort((left, right) =>
        Number(left.data?.chunkIndex) - Number(right.data?.chunkIndex))
      .map((record) => record.data?.responseChunk)
      .join("");
    expect(rawErrors).toBe(responseText);
  });

  it("logs the original invalid-JSON error and reads the response body only once", async () => {
    const responseTextMock = vi.fn(async () => "not-json");
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      text: responseTextMock,
    }));

    await expect(diagnosticService.lookup(candidate)).rejects.toThrow(
      /returned invalid JSON/,
    );

    expect(responseTextMock).toHaveBeenCalledTimes(1);
    const failure = diagnosticRecords.find((record) =>
      record.event === "shopify.abandoned_checkout.graphql.provider_failure");
    expect(failure?.data).toMatchObject({
      reasonCode: "INVALID_JSON",
      error: { name: "SyntaxError" },
    });
    expect(String((failure?.data?.error as Record<string, unknown>)?.message))
      .toContain("not valid JSON");
  });
});


