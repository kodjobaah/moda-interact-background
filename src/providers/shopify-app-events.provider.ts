const TOKEN_ENDPOINT = "https://api.shopify.com/auth/access_token";
const EVENTS_ENDPOINT = "https://api.shopify.com/app/2026-07/events";
const DEFAULT_SAFETY_MARGIN_SECONDS = 60;

export type ShopifyAppEventsErrorKind =
  | "configuration"
  | "authentication-refreshable"
  | "throttled"
  | "transient"
  | "server"
  | "transport"
  | "request"
  | "period"
  | "meter";

export class ShopifyAppEventsError extends Error {
  readonly name = "ShopifyAppEventsError";
  readonly retryable: boolean;
  readonly needsAttention: boolean;

  constructor(
    readonly kind: ShopifyAppEventsErrorKind,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.retryable = [
      "authentication-refreshable",
      "throttled",
      "transient",
      "server",
      "transport",
    ].includes(kind);
    this.needsAttention = [
      "configuration",
      "request",
      "period",
      "meter",
    ].includes(kind);
  }
}

export type ShopifyAppEventsConfig = {
  clientId: string;
  clientSecret: string;
  safetyMarginSeconds?: number;
};

export type ShopifyBillingEvent = {
  shopId: string;
  eventHandle: string;
  occurredAt: string;
  idempotencyKey: string;
  value: number;
};

export type ShopifyAppEventsFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function readShopifyAppEventsConfig(
  env: NodeJS.ProcessEnv = process.env,
): ShopifyAppEventsConfig {
  const clientId = env.SHOPIFY_APP_EVENTS_CLIENT_ID?.trim();
  const clientSecret = env.SHOPIFY_APP_EVENTS_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new ShopifyAppEventsError(
      "configuration",
      "Shopify App Events client credentials are missing",
    );
  }

  return { clientId, clientSecret };
}

export class ShopifyAppEventsClient {
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private tokenRefresh: Promise<string> | null = null;
  private readonly safetyMarginSeconds: number;

  constructor(
    private readonly config: ShopifyAppEventsConfig,
    private readonly fetchImpl: ShopifyAppEventsFetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (!config.clientId.trim() || !config.clientSecret.trim()) {
      throw new ShopifyAppEventsError(
        "configuration",
        "Shopify App Events client credentials are missing",
      );
    }

    const requestedMargin = config.safetyMarginSeconds ?? DEFAULT_SAFETY_MARGIN_SECONDS;
    if (!Number.isFinite(requestedMargin) || requestedMargin < 0) {
      throw new ShopifyAppEventsError(
        "configuration",
        "Shopify App Events token safety margin must be non-negative",
      );
    }

    this.safetyMarginSeconds = requestedMargin;
  }

  async createBillingEvent(event: ShopifyBillingEvent): Promise<void> {
    this.validateEvent(event);

    let token = await this.getToken();
    let response = await this.postEvent(token, event);

    if (response.status === 401) {
      token = await this.refreshAfterUnauthorized(token);
      response = await this.postEvent(token, event);
    }

    if (!response.ok) {
      throw await this.classifyResponse(response, "event");
    }
  }

  private async getToken(forceRefresh = false): Promise<string> {
    const now = this.now();
    if (
      !forceRefresh &&
      this.cachedToken &&
      now < this.cachedToken.expiresAt
    ) {
      return this.cachedToken.value;
    }

    if (this.tokenRefresh) {
      return this.tokenRefresh;
    }

    this.tokenRefresh = this.refreshToken();
    try {
      return await this.tokenRefresh;
    } finally {
      this.tokenRefresh = null;
    }
  }

  private async refreshAfterUnauthorized(rejectedToken: string): Promise<string> {
    if (this.cachedToken?.value === rejectedToken) {
      this.cachedToken = null;
    }

    return this.getToken();
  }

  private async refreshToken(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: "client_credentials",
        }),
      });
    } catch (error) {
      throw new ShopifyAppEventsError(
        "transport",
        "Shopify App Events token request failed",
        { cause: error },
      );
    }

    if (!response.ok) {
      throw await this.classifyResponse(response, "token");
    }

    const body = await this.readJson(response, "token");
    if (
      typeof body.access_token !== "string" ||
      !body.access_token ||
      typeof body.expires_in !== "number" ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0
    ) {
      throw new ShopifyAppEventsError(
        "authentication-refreshable",
        "Shopify App Events token response is invalid",
      );
    }

    const margin = Math.min(
      this.safetyMarginSeconds,
      Math.max(0, body.expires_in - 1),
    );
    this.cachedToken = {
      value: body.access_token,
      expiresAt: this.now() + (body.expires_in - margin) * 1000,
    };
    return body.access_token;
  }

  private async postEvent(
    token: string,
    event: ShopifyBillingEvent,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(EVENTS_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shop_id: event.shopId,
          event_handle: event.eventHandle,
          timestamp: event.occurredAt,
          idempotency_key: event.idempotencyKey,
          attributes: { value: event.value },
        }),
      });
    } catch (error) {
      throw new ShopifyAppEventsError(
        "transport",
        "Shopify App Events request failed",
        { cause: error },
      );
    }
  }

  private async classifyResponse(
    response: Response,
    operation: "token" | "event",
  ): Promise<ShopifyAppEventsError> {
    const body = await response.text();
    const lowerBody = body.toLowerCase();

    if (response.status === 401 || response.status === 403) {
      return new ShopifyAppEventsError(
        "configuration",
        `Shopify App Events ${operation} authentication was rejected`,
      );
    }
    if (response.status === 429) {
      return new ShopifyAppEventsError(
        "throttled",
        "Shopify App Events request was throttled",
      );
    }
    if (response.status >= 500) {
      return new ShopifyAppEventsError(
        "server",
        "Shopify App Events server error",
      );
    }
    if (response.status === 408 || response.status === 425) {
      return new ShopifyAppEventsError(
        "transient",
        "Shopify App Events request is temporarily unavailable",
      );
    }
    if (lowerBody.includes("period") || lowerBody.includes("billing window")) {
      return new ShopifyAppEventsError(
        "period",
        "Shopify rejected the billing event period",
      );
    }
    if (lowerBody.includes("meter") || lowerBody.includes("event handle")) {
      return new ShopifyAppEventsError(
        "meter",
        "Shopify rejected the billing event meter",
      );
    }
    return new ShopifyAppEventsError(
      "request",
      `Shopify App Events ${operation} request was rejected`,
    );
  }

  private async readJson(response: Response, operation: "token"): Promise<Record<string, unknown>> {
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object") {
        return body as Record<string, unknown>;
      }
    } catch (error) {
      throw new ShopifyAppEventsError(
        "authentication-refreshable",
        `Shopify App Events ${operation} response was invalid JSON`,
        { cause: error },
      );
    }
    throw new ShopifyAppEventsError(
      "authentication-refreshable",
      `Shopify App Events ${operation} response was invalid JSON`,
    );
  }

  private validateEvent(event: ShopifyBillingEvent): void {
    if (!event.shopId.trim() || !event.eventHandle.trim()) {
      throw new ShopifyAppEventsError(
        "request",
        "Shopify App Events shop ID and event handle are required",
      );
    }
    if (!event.occurredAt || Number.isNaN(Date.parse(event.occurredAt))) {
      throw new ShopifyAppEventsError(
        "period",
        "Shopify App Events timestamp must be an ISO-8601 timestamp",
      );
    }
    if (!event.idempotencyKey || event.idempotencyKey.length > 64) {
      throw new ShopifyAppEventsError(
        "request",
        "Shopify App Events idempotency key must be 1 to 64 characters",
      );
    }
    if (!Number.isInteger(event.value) || event.value === 0) {
      throw new ShopifyAppEventsError(
        "request",
        "Shopify App Events value must be a non-zero integer",
      );
    }
  }
}