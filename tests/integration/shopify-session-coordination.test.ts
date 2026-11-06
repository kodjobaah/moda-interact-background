import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createShopifySessionService } from "../../src/services/shopify-session.service.js";

const enabled = process.env.MODA_DISPOSABLE_INTEGRATION === "1";
const describeWithDatabase = enabled ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL;
let primary: PrismaClient | undefined;
let second: PrismaClient | undefined;
let observer: PrismaClient | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function tokenResponse(accessToken: string, refreshToken: string) {
  return Response.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3_600,
    refresh_token_expires_in: 86_400,
    scope: "read_products,read_discounts",
  });
}

async function waitForAdvisoryLockWait(): Promise<void> {
  const db = observer;
  if (!db) throw new Error("Disposable PostgreSQL observer is unavailable");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    `);
    if ((rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The second Background Prisma client did not wait on the shared Shopify gate");
}

describeWithDatabase("Background Shared Shopify session provider PostgreSQL", () => {
  beforeAll(async () => {
    if (!databaseUrl) throw new Error("Disposable integration DATABASE_URL is unavailable");
    primary = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    second = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    observer = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await Promise.all([primary.$connect(), second.$connect(), observer.$connect()]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([primary?.$disconnect(), second?.$disconnect(), observer?.$disconnect()]);
  }, 30_000);

  it("serializes two service-owned Prisma clients and atomically persists one rotated credential pair", async () => {
    const db = primary;
    const secondClient = second;
    const inspection = observer;
    if (!db || !secondClient || !inspection) throw new Error("Disposable PostgreSQL clients are unavailable");

    const suffix = randomUUID().replaceAll("-", "");
    const domain = `background-${suffix}.myshopify.com`;
    const shop = await db.shop.create({ data: { domain, platform: "SHOPIFY", status: "ACTIVE" } });
    const sessionId = `background-offline-${suffix}`;
    await db.session.create({ data: {
      id: sessionId,
      shop: domain,
      state: "integration-test",
      isOnline: false,
      scope: "read_products,read_discounts",
      accessToken: "old-access-token",
      expires: new Date(Date.now() - 60_000),
      refreshToken: "old-refresh-token",
      refreshTokenExpires: new Date(Date.now() + 86_400_000),
    } });

    const responseReady = deferred<Response>();
    const requestStarted = deferred<void>();
    const nativeFetch = vi.fn(async () => {
      requestStarted.resolve();
      return responseReady.promise;
    });
    const configuration = { read: vi.fn(async () => ({ value: { apiKey: "test-key", apiSecret: "test-secret" } })) } as never;
    const firstService = createShopifySessionService({ database: db, configuration, fetchImpl: nativeFetch });
    const secondService = createShopifySessionService({ database: secondClient, configuration, fetchImpl: nativeFetch });

    try {
      const first = firstService.getAccessToken(shop.id);
      await requestStarted.promise;
      const secondRead = secondService.getAccessToken(shop.id);
      await waitForAdvisoryLockWait();

      expect(await inspection.session.findUniqueOrThrow({ where: { id: sessionId } }))
        .toMatchObject({ accessToken: "old-access-token", refreshToken: "old-refresh-token" });
      responseReady.resolve(tokenResponse("rotated-access-token", "rotated-refresh-token"));

      await expect(Promise.all([first, secondRead])).resolves.toEqual([
        "rotated-access-token", "rotated-access-token",
      ]);
      expect(nativeFetch).toHaveBeenCalledTimes(1);
      expect(configuration.read).toHaveBeenCalledTimes(1);
      expect(await inspection.session.findUniqueOrThrow({ where: { id: sessionId } }))
        .toMatchObject({ accessToken: "rotated-access-token", refreshToken: "rotated-refresh-token" });
    } finally {
      responseReady.resolve(tokenResponse("cleanup-access-token", "cleanup-refresh-token"));
      await db.session.deleteMany({ where: { id: sessionId } });
      await db.shop.deleteMany({ where: { id: shop.id } });
    }
  }, 30_000);

  it("rejects an inactive selected Shop before OAuth transport", async () => {
    const db = primary;
    if (!db) throw new Error("Disposable PostgreSQL client is unavailable");
    const suffix = randomUUID().replaceAll("-", "");
    const shop = await db.shop.create({ data: { domain: `inactive-${suffix}.myshopify.com`, platform: "SHOPIFY", status: "UNINSTALLED" } });
    const nativeFetch = vi.fn(async () => tokenResponse("should-not-run", "should-not-run"));
    const service = createShopifySessionService({
      database: db,
      configuration: { read: vi.fn() } as never,
      fetchImpl: nativeFetch,
    });
    try {
      await expect(service.getAccessToken(shop.id)).rejects.toMatchObject({ code: "INVALID_SESSION" });
      expect(nativeFetch).not.toHaveBeenCalled();
    } finally {
      await db.shop.deleteMany({ where: { id: shop.id } });
    }
  }, 15_000);

  it("maps provider failure with token canaries to the Shared fixed error without logging response secrets", async () => {
    const db = primary;
    if (!db) throw new Error("Disposable PostgreSQL client is unavailable");
    const suffix = randomUUID().replaceAll("-", "");
    const domain = `provider-failure-${suffix}.myshopify.com`;
    const shop = await db.shop.create({ data: { domain, platform: "SHOPIFY", status: "ACTIVE" } });
    const sessionId = `provider-failure-offline-${suffix}`;
    const responseCanary = "provider-body-canary";
    const secretCanary = "oauth-secret-canary";
    await db.session.create({ data: {
      id: sessionId,
      shop: domain,
      state: "integration-test",
      isOnline: false,
      accessToken: "expired-access-canary",
      expires: new Date(Date.now() - 60_000),
      refreshToken: "refresh-token-canary",
      refreshTokenExpires: new Date(Date.now() + 86_400_000),
    } });
    const nativeFetch = vi.fn(async () => new Response(responseCanary, { status: 500 }));
    const service = createShopifySessionService({
      database: db,
      configuration: { read: vi.fn(async () => ({ value: { apiKey: "oauth-key-canary", apiSecret: secretCanary } })) } as never,
      fetchImpl: nativeFetch,
    });
    const errorLog = vi.spyOn(console, "error");
    const warnLog = vi.spyOn(console, "warn");
    try {
      let failure: unknown;
      try {
        await service.getAccessToken(shop.id);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "REFRESH_OUTCOME_UNKNOWN" });
      const diagnostic = failure instanceof Error ? `${failure.name} ${failure.message} ${failure.stack ?? ""}` : String(failure);
      for (const canary of [responseCanary, secretCanary, "oauth-key-canary", "expired-access-canary", "refresh-token-canary"]) {
        expect(diagnostic).not.toContain(canary);
      }
      expect(errorLog).not.toHaveBeenCalled();
      expect(warnLog).not.toHaveBeenCalled();
      expect(nativeFetch).toHaveBeenCalledTimes(1);
      expect(await db.session.findUniqueOrThrow({ where: { id: sessionId } }))
        .toMatchObject({ accessToken: "expired-access-canary", refreshToken: "refresh-token-canary" });
    } finally {
      errorLog.mockRestore();
      warnLog.mockRestore();
      await db.session.deleteMany({ where: { id: sessionId } });
      await db.shop.deleteMany({ where: { id: shop.id } });
    }
  }, 15_000);
});
