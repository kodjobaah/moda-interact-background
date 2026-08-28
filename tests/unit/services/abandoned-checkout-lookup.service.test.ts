import { beforeEach, describe, expect, it, vi } from "vitest";

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

const service = new AbandonedCheckoutLookupService();

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
    currencyCode: "USD",
    totalPrice: { amount: "49.99", currencyCode: "USD" },
    customer: {
      id: "gid://shopify/Customer/999",
      email: "buyer@example.com",
      phone: "+15551234567",
      firstName: "Ada",
      lastName: "Lovelace",
    },
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/AbandonedCheckoutLineItem/1",
          product: { id: "gid://shopify/Product/1" },
          variant: { id: "gid://shopify/ProductVariant/1", sku: "SKU-1" },
          title: "Teal Dress",
          variantTitle: "M",
          quantity: 2,
          originalUnitPrice: { amount: "20.00", currencyCode: "USD" },
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
    json: async () => ({
      data: { abandonedCheckoutsCount: { count } },
    }),
  }));
}

function mockListResponse(nodes: unknown[]) {
  fetchMock.mockImplementationOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: { abandonedCheckouts: { nodes } },
    }),
  }));
}

describe("abandoned checkout lookup service", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    getToken.mockClear();
    prismaMock.shop.findUnique.mockReset();
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
    }
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
    mockCountResponse(50);

    const result = await service.lookup(candidate);

    expect(result.kind).toBe("bounded-limit-exceeded");

    if (result.kind === "bounded-limit-exceeded") {
      expect(result.candidateCount).toBe(50);
    }

    // The bounded list query must never run once the count pre-check fails,
    // proving the implementation cannot enumerate an unbounded history.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps provider errors distinct from not-found", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      domain: candidate.shopDomain,
    });

    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      text: async () => "server error",
    }));

    await expect(service.lookup(candidate)).rejects.toThrow(
      /Shopify abandoned-checkout GraphQL request failed/,
    );
  });

  it("throws on GraphQL errors rather than treating them as not-found", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      domain: candidate.shopDomain,
    });

    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: "boom" }] }),
    }));

    await expect(service.lookup(candidate)).rejects.toThrow(/GraphQL error/);
  });

  it("derives a narrow created_at filter from checkoutCreatedAt", async () => {
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
    expect(query).toMatch(/AND/);
    // Only one Shopify call: the bounded count pre-check (no list query).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


