import type { PrismaClient } from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import {
  createShopifyOfflineTokenProvider,
  ShopifyOfflineTokenError,
  type ShopifyOfflineRefreshEvent,
  type ShopifyOfflineDatabase,
} from "@modainteract/moda-interact-shared/shopify/node";
import prisma from "../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { platformConsumerConfiguration } from "./platform-configuration/consumers.js";

type OAuthConfigurationReader = Pick<typeof platformConsumerConfiguration, "read">;

const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

/** Compose the published Shared reader with this service's own Prisma/config/fetch ports. */
export function createShopifySessionService(input: {
  database?: PrismaClient;
  configuration?: OAuthConfigurationReader;
  fetchImpl?: typeof fetch;
} = {}) {
  const database = input.database ?? prisma;
  const configuration = input.configuration ?? platformConsumerConfiguration;
  const provider = createShopifyOfflineTokenProvider({
    prisma: database as unknown as ShopifyOfflineDatabase,
    readOAuth: async () => {
      const { value } = await configuration.read("shopify.oauth");
      return { apiKey: value.apiKey, apiSecret: value.apiSecret };
    },
    fetch: input.fetchImpl ?? globalThis.fetch,
    onEvent: (event: ShopifyOfflineRefreshEvent) => {
      const fields = {
        operationId: event.operationId,
        shopId: event.shopId,
        source: event.source,
        durationMs: event.durationMs,
        outcome: event.outcome,
        reasonCode: event.reasonCode,
      };

      try {
        if (event.event === "shopify.offline_refresh.failed") {
          logger.warn(event.event, fields);
        } else {
          logger.info(event.event, fields);
        }
      } catch {
        // Logging must never change the provider refresh outcome.
      }
    },
  });

  return Object.freeze({
    getAccessToken: (shopId: string, options?: { signal?: AbortSignal }) =>
      provider.getAccessToken(shopId, options),
    getSession: (shopId: string, options?: { signal?: AbortSignal }) =>
      provider.getSession(shopId, options),
  });
}

const shopifySessionService = createShopifySessionService();

/** Resolve domain-only internal callers back to one active, stored Shopify Shop. */
export async function resolveShopifyShopId(shopDomain: string): Promise<string> {
  let shops: Array<{ id: string }>;
  try {
    shops = await prisma.shop.findMany({
      where: { domain: shopDomain, platform: "SHOPIFY", status: "ACTIVE" },
      select: { id: true },
      take: 2,
    });
  } catch {
    throw new ShopifyOfflineTokenError("PERSISTENCE_UNAVAILABLE");
  }
  if (shops.length === 0) throw new ShopifyOfflineTokenError("SESSION_MISSING");
  if (shops.length !== 1) throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
  return shops[0]!.id;
}

/** Domain-only callers must still use an exact active Shop mapping before reading credentials. */
export async function getShopifyAccessTokenForDomain(
  shopDomain: string,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const shopId = await resolveShopifyShopId(shopDomain);
  return shopifySessionService.getAccessToken(shopId, options);
}

/** `shopId` is selected by the already-authorized caller; Shared revalidates Shop/session identity. */
export function getShopifyAccessToken(
  shopId: string,
  options?: { signal?: AbortSignal },
): Promise<string> {
  return shopifySessionService.getAccessToken(shopId, options);
}

/** Return Shared's server-only credential snapshot for the authorized selected Shop. */
export function getShopifySession(
  shopId: string,
  options?: { signal?: AbortSignal },
) {
  return shopifySessionService.getSession(shopId, options);
}
