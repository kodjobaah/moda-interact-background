import { describe, expect, it, vi } from "vitest";
import {
  readShopifyAppEventsConfig,
  ShopifyAppEventsClient,
  ShopifyAppEventsError,
} from "../../../src/providers/shopify-app-events.provider.js";

const event = {
  shopId: "gid://shopify/Shop/123",
  eventHandle: "recovery-conversation",
  occurredAt: "2026-09-08T00:00:00.000Z",
  idempotencyKey: "usage-event-123",
  value: 1,
};

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tokenResponse(accessToken = "token-1", expiresIn = 3599): Response {
  return response(200, { access_token: accessToken, expires_in: expiresIn });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createClient(
  fetchImpl: ReturnType<typeof vi.fn>,
  now: () => number = () => 0,
  safetyMarginSeconds = 60,
): ShopifyAppEventsClient {
  return new ShopifyAppEventsClient(
    {
      clientId: "app-client-id",
      clientSecret: "app-client-secret",
      safetyMarginSeconds,
    },
    fetchImpl,
    now,
  );
}

describe("ShopifyAppEventsClient", () => {
  it("validates dedicated App Events credentials", () => {
    expect(() => readShopifyAppEventsConfig({})).toThrowError(
      ShopifyAppEventsError,
    );
    expect(
      readShopifyAppEventsConfig({
        SHOPIFY_APP_EVENTS_CLIENT_ID: " client-id ",
        SHOPIFY_APP_EVENTS_CLIENT_SECRET: " client-secret ",
      }),
    ).toEqual({ clientId: "client-id", clientSecret: "client-secret" });
  });

  it("reuses a token and shares one concurrent refresh", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValue(response(202));
    const client = createClient(fetchImpl);

    await Promise.all([client.createBillingEvent(event), client.createBillingEvent(event)]);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://api.shopify.com/auth/access_token",
    );
  });

  it("refreshes at the configured expiry safety margin", async () => {
    let now = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("token-1", 100))
      .mockResolvedValueOnce(response(202))
      .mockResolvedValueOnce(tokenResponse("token-2", 100))
      .mockResolvedValueOnce(response(202));
    const client = createClient(fetchImpl, () => now, 10);

    await client.createBillingEvent(event);
    now = 90_001;
    await client.createBillingEvent(event);

    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer token-1" },
    });
    expect(fetchImpl.mock.calls[3]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer token-2" },
    });
  });

  it("sends the exact 2026-07 event shape without PII", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response(202));
    const client = createClient(fetchImpl);

    await client.createBillingEvent(event);

    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "https://api.shopify.com/app/2026-07/events",
    );
    expect(JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string)).toEqual({
      shop_id: event.shopId,
      event_handle: event.eventHandle,
      timestamp: event.occurredAt,
      idempotency_key: event.idempotencyKey,
      attributes: { value: 1 },
    });
    expect(JSON.stringify(fetchImpl.mock.calls[1])).not.toContain("app-client-secret");
  });

  it("rejects an overlong idempotency key and zero values before fetching", async () => {
    const fetchImpl = vi.fn();
    const client = createClient(fetchImpl);

    await expect(
      client.createBillingEvent({ ...event, idempotencyKey: "x".repeat(65) }),
    ).rejects.toMatchObject({ kind: "request", needsAttention: true });
    await expect(
      client.createBillingEvent({ ...event, value: 0 }),
    ).rejects.toMatchObject({ kind: "request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes exactly once after an expired-token 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("token-1"))
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(tokenResponse("token-2"))
      .mockResolvedValueOnce(response(202));
    const client = createClient(fetchImpl);

    await client.createBillingEvent(event);

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[3]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer token-2" },
    });
  });

  it("shares replacement-token refresh across staggered concurrent 401 responses", async () => {
    const initialResponses = [deferred<Response>(), deferred<Response>()];
    const retryResponses = [response(202), response(202)];
    let tokenRequests = 0;
    let eventRequests = 0;
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      if (String(input) === "https://api.shopify.com/auth/access_token") {
        tokenRequests += 1;
        if (tokenRequests === 1) {
          return tokenResponse("token-1");
        }
        if (tokenRequests === 2) {
          return tokenResponse("token-2");
        }
        throw new Error("unexpected token-3 refresh");
      }

      eventRequests += 1;
      if (eventRequests <= 2) {
        return initialResponses[eventRequests - 1]?.promise;
      }
      return retryResponses[eventRequests - 3];
    });
    const client = createClient(fetchImpl);

    const firstSend = client.createBillingEvent(event);
    const secondSend = client.createBillingEvent(event);
    await vi.waitFor(() => expect(eventRequests).toBe(2));

    initialResponses[0]?.resolve(response(401));
    await vi.waitFor(() => expect(tokenRequests).toBe(2));
    initialResponses[1]?.resolve(response(401));

    await Promise.all([firstSend, secondSend]);

    expect(tokenRequests).toBe(2);
    const eventCalls = fetchImpl.mock.calls.filter(
      ([input]) => String(input) === "https://api.shopify.com/app/2026-07/events",
    );
    expect(eventCalls).toHaveLength(4);
    expect(eventCalls.map(([, init]) => (init?.headers as Record<string, string>).Authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-1",
      "Bearer token-2",
      "Bearer token-2",
    ]);
  });

  it.each([401, 403] as const)(
    "classifies token endpoint HTTP %s as definitive configuration",
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(response(status));
      const client = createClient(fetchImpl);

      await expect(client.createBillingEvent(event)).rejects.toMatchObject({
        kind: "configuration",
        retryable: false,
        needsAttention: true,
      });
    },
  );

  it("classifies a second event 401 as definitive after one controlled refresh", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("token-1"))
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(tokenResponse("token-2"))
      .mockResolvedValueOnce(response(401));
    const client = createClient(fetchImpl);

    await expect(client.createBillingEvent(event)).rejects.toMatchObject({
      kind: "configuration",
      retryable: false,
      needsAttention: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("classifies event 403 as definitive without refreshing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("token-1"))
      .mockResolvedValueOnce(response(403));
    const client = createClient(fetchImpl);

    await expect(client.createBillingEvent(event)).rejects.toMatchObject({
      kind: "configuration",
      retryable: false,
      needsAttention: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [429, "throttled"],
    [408, "transient"],
    [500, "server"],
    [400, "request"],
  ] as const)("classifies HTTP %s as %s", async (status, kind) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response(status));
    const client = createClient(fetchImpl);

    await expect(client.createBillingEvent(event)).rejects.toMatchObject({ kind });
  });

  it("classifies period and meter errors as needs-attention", async () => {
    for (const [body, kind] of [
      [{ error: "billing window is invalid" }, "period"],
      [{ error: "unknown meter handle" }, "meter"],
    ] as const) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(response(422, body));
      const client = createClient(fetchImpl);

      await expect(client.createBillingEvent(event)).rejects.toMatchObject({
        kind,
        retryable: false,
        needsAttention: true,
      });
    }
  });

  it("classifies transport errors as retryable without exposing secrets", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket closed"));
    const client = createClient(fetchImpl);

    const thrown = await client.createBillingEvent(event).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ kind: "transport", retryable: true });
    expect(String(thrown)).not.toContain("app-client-secret");
  });
});