import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const database = { shop: { findMany: vi.fn() } };
  const state: { providerInput?: { readOAuth: () => Promise<unknown>; fetch: typeof fetch; onEvent?: (event: unknown) => void } } = {};
  const logger = { info: vi.fn(), warn: vi.fn() };
  const getAccessToken = vi.fn(async () => {
    await state.providerInput?.readOAuth();
    return "test-access-token";
  });
  const getSession = vi.fn(async () => {
    return { id: "offline-1", shopId: "selected-shop-1", shop: "merchant.myshopify.com", accessToken: "test-access-token", scope: null, expires: null, refreshTokenExpires: null };
  });
  return { database, state, logger, getAccessToken, getSession };
});

vi.mock("../../../src/lib/db.js", () => ({ default: mocks.database }));
vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: vi.fn(() => mocks.logger),
}));
vi.mock("../../../src/services/platform-configuration/consumers.js", () => ({
  platformConsumerConfiguration: { read: vi.fn() },
}));
vi.mock("@modainteract/moda-interact-shared/shopify/node", () => ({
  ShopifyOfflineTokenError: class ShopifyOfflineTokenError extends Error {
    constructor(readonly code: string) { super(`safe:${code}`); }
  },
  createShopifyOfflineTokenProvider: vi.fn((input: { readOAuth: () => Promise<unknown>; fetch: typeof fetch; onEvent?: (event: unknown) => void }) => {
    mocks.state.providerInput = input;
    return { getAccessToken: mocks.getAccessToken, getSession: mocks.getSession };
  }),
}));

import { createShopifyOfflineTokenProvider } from "@modainteract/moda-interact-shared/shopify/node";
import {
  createShopifySessionService,
  getShopifyAccessTokenForDomain,
  getShopifySession,
  resolveShopifyShopId,
} from "../../../src/services/shopify-session.service.js";

afterEach(() => vi.clearAllMocks());

describe("Background Shopify offline session service", () => {
  it("composes the service-owned client and reads shopify.oauth on each refresh", async () => {
    const database = {} as PrismaClient;
    const configRead = vi.fn(async () => ({ value: { apiKey: "configured-key", apiSecret: "configured-secret" } }));
    const configuration = { read: configRead } as never;
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const service = createShopifySessionService({ database, configuration, fetchImpl });

    await expect(service.getAccessToken("selected-shop-1")).resolves.toBe("test-access-token");
    await expect(service.getAccessToken("selected-shop-1", { signal: AbortSignal.timeout(1000) }))
      .resolves.toBe("test-access-token");

    expect(createShopifyOfflineTokenProvider).toHaveBeenCalledWith(expect.objectContaining({
      prisma: database,
      fetch: fetchImpl,
    }));
    expect(configRead).toHaveBeenCalledTimes(2);
    expect(configRead).toHaveBeenNthCalledWith(1, "shopify.oauth");
    expect(configRead).toHaveBeenNthCalledWith(2, "shopify.oauth");
  });

  it("logs only bounded refresh-event fields at the event-specific level", () => {
    const previousProviderInput = mocks.state.providerInput;
    createShopifySessionService();
    const onEvent = mocks.state.providerInput?.onEvent;
    mocks.state.providerInput = previousProviderInput;
    expect(onEvent).toBeTypeOf("function");

    const eventFields = {
      operationId: "operation-canary",
      shopId: "shop-id-canary",
      source: "SHARED",
      durationMs: 42,
      outcome: "STARTED",
      reasonCode: null,
    };
    const secretCanaries = {
      body: "body-secret-canary",
      cause: "cause-secret-canary",
      domain: "domain-secret-canary.myshopify.com",
      session: "session-secret-canary",
      token: "token-secret-canary",
    };

    onEvent?.({ event: "shopify.offline_refresh.started", ...eventFields, ...secretCanaries });
    onEvent?.({
      event: "shopify.offline_refresh.committed",
      ...eventFields,
      outcome: "COMMITTED",
      ...secretCanaries,
    });
    onEvent?.({
      event: "shopify.offline_refresh.failed",
      ...eventFields,
      outcome: "REJECTED",
      reasonCode: "REFRESH_REJECTED",
      ...secretCanaries,
    });

    expect(mocks.logger.info).toHaveBeenNthCalledWith(1, "shopify.offline_refresh.started", eventFields);
    expect(mocks.logger.info).toHaveBeenNthCalledWith(2, "shopify.offline_refresh.committed", {
      ...eventFields,
      outcome: "COMMITTED",
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith("shopify.offline_refresh.failed", {
      ...eventFields,
      outcome: "REJECTED",
      reasonCode: "REFRESH_REJECTED",
    });

    const loggedPayload = JSON.stringify([mocks.logger.info.mock.calls, mocks.logger.warn.mock.calls]);
    for (const canary of Object.values(secretCanaries)) expect(loggedPayload).not.toContain(canary);
  });

  it("isolates logger failures from provider refresh behavior", () => {
    const previousProviderInput = mocks.state.providerInput;
    createShopifySessionService();
    const onEvent = mocks.state.providerInput?.onEvent;
    mocks.state.providerInput = previousProviderInput;
    mocks.logger.info.mockImplementationOnce(() => {
      throw new Error("logger sink failure");
    });

    expect(() => onEvent?.({
      event: "shopify.offline_refresh.started",
      operationId: "operation-1",
      shopId: "shop-1",
      source: "SHARED",
      durationMs: 0,
      outcome: "STARTED",
      reasonCode: null,
    })).not.toThrow();
  });

  it("exposes the coordinated server-side snapshot by selected Shop ID", async () => {
    const snapshot = await getShopifySession("selected-shop-1");
    expect(snapshot).toMatchObject({
      id: "offline-1", shopId: "selected-shop-1", shop: "merchant.myshopify.com", accessToken: "test-access-token",
    });
    expect(mocks.getSession).toHaveBeenCalledWith("selected-shop-1", undefined);
  });

  it("resolves a domain-only internal caller to exactly one active Shopify Shop ID", async () => {
    mocks.database.shop.findMany.mockResolvedValue([{ id: "selected-shop-2" }]);

    await expect(getShopifyAccessTokenForDomain("merchant.myshopify.com"))
      .resolves.toBe("test-access-token");

    expect(mocks.database.shop.findMany).toHaveBeenCalledWith({
      where: { domain: "merchant.myshopify.com", platform: "SHOPIFY", status: "ACTIVE" },
      select: { id: true },
      take: 2,
    });
    expect(mocks.getAccessToken).toHaveBeenCalledWith("selected-shop-2", undefined);
  });

  it("fails closed when a stored domain is missing or ambiguous", async () => {
    mocks.database.shop.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "shop-one" }, { id: "shop-two" },
    ]);

    await expect(resolveShopifyShopId("missing.myshopify.com")).rejects.toMatchObject({ code: "SESSION_MISSING" });
    await expect(resolveShopifyShopId("duplicate.myshopify.com"))
      .rejects.toMatchObject({ code: "SESSION_IDENTITY_CONFLICT" });
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });
});
