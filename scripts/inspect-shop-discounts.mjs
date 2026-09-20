#!/usr/bin/env node

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const API_VERSION = "2026-07";
const PAGE_SIZE = 100;

const QUERY = `#graphql
query DiscountNodes($first: Int!, $after: String) {
  discountNodes(first: $first, after: $after) {
    nodes {
      id
      discount {
        __typename
        ... on DiscountAutomaticApp {
          title status startsAt endsAt
        }
        ... on DiscountAutomaticBasic {
          title summary status startsAt endsAt
        }
        ... on DiscountAutomaticBxgy {
          title summary status startsAt endsAt
        }
        ... on DiscountAutomaticFreeShipping {
          title summary status startsAt endsAt
        }
        ... on DiscountCodeApp {
          title status startsAt endsAt
          codesCount { count precision }
          codes(first: 2) {
            nodes { code }
            pageInfo { hasNextPage }
          }
        }
        ... on DiscountCodeBasic {
          title summary status startsAt endsAt
          codesCount { count precision }
          codes(first: 2) {
            nodes { code }
            pageInfo { hasNextPage }
          }
        }
        ... on DiscountCodeBxgy {
          title summary status startsAt endsAt
          codesCount { count precision }
          codes(first: 2) {
            nodes { code }
            pageInfo { hasNextPage }
          }
        }
        ... on DiscountCodeFreeShipping {
          title summary status startsAt endsAt
          codesCount { count precision }
          codes(first: 2) {
            nodes { code }
            pageInfo { hasNextPage }
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

function usage() {
  return `
Inspect the discounts currently offered by a Shopify store.

Usage:
  node scripts/inspect-shop-discounts.mjs --shop <shop-domain-or-id>
  node scripts/inspect-shop-discounts.mjs --shop <shop-domain-or-id> --all
  node scripts/inspect-shop-discounts.mjs --shop <shop-domain-or-id> --selectable-only
  node scripts/inspect-shop-discounts.mjs --shop <shop-domain-or-id> --json

Options:
  --shop <value>       Required. Shopify domain or Moda Shop.id.
  --all                Include non-ACTIVE discounts (scheduled/expired/etc.).
  --selectable-only    Show only discounts Moda can use as a fixed recovery offer.
  --json               Print machine-readable JSON instead of a table.
  --help               Show this help.

Environment:
  DATABASE_URL         Required so the script can read the shop's offline Session.
  SHOPIFY_API_KEY      Required only if an expired token has to be refreshed.
  SHOPIFY_API_SECRET   Required only if an expired token has to be refreshed.

This script is read-only with respect to Shopify discounts. It never creates,
updates or deletes a discount. The only possible write is refreshing an expired
offline Shopify access token, matching the application's existing session logic.
`.trim();
}

function arg(name) {
  const equals = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);

  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

async function resolveShop(value) {
  if (!value) {
    throw new Error("--shop is required.");
  }

  const normalized = String(value).trim().toLowerCase();

  const shop = await prisma.shop.findFirst({
    where: {
      OR: [
        { id: String(value).trim() },
        { domain: normalized },
      ],
    },
    select: {
      id: true,
      domain: true,
      status: true,
    },
  });

  if (!shop) {
    throw new Error(`Shop not found for --shop ${value}`);
  }

  return shop;
}

async function getShopifyAccessToken(shopDomain) {
  const session = await prisma.session.findFirst({
    where: {
      shop: shopDomain,
      isOnline: false,
    },
    orderBy: {
      expires: "desc",
    },
  });

  if (!session) {
    throw new Error(`No offline Shopify session found for ${shopDomain}`);
  }

  if (!session.accessToken) {
    throw new Error(`Offline Shopify session has no access token for ${shopDomain}`);
  }

  const scopes = new Set(
    String(session.scope ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );

  if (!scopes.has("read_discounts")) {
    throw new Error(
      `Offline Shopify session for ${shopDomain} does not include read_discounts. ` +
        `Current scopes: ${[...scopes].join(", ") || "(none)"}`,
    );
  }

  if (!session.expires || session.expires > new Date()) {
    return session.accessToken;
  }

  if (!session.refreshToken) {
    throw new Error(
      `Offline Shopify access token expired for ${shopDomain} and no refresh token exists.`,
    );
  }

  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "SHOPIFY_API_KEY and SHOPIFY_API_SECRET are required to refresh the expired offline token.",
    );
  }

  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    }),
  });

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Failed to refresh Shopify access token: ${response.status} ${bodyText.slice(0, 500)}`,
    );
  }

  let refreshed;
  try {
    refreshed = JSON.parse(bodyText);
  } catch {
    throw new Error("Shopify token refresh returned invalid JSON.");
  }

  if (
    typeof refreshed.access_token !== "string" ||
    typeof refreshed.expires_in !== "number" ||
    typeof refreshed.refresh_token !== "string" ||
    typeof refreshed.refresh_token_expires_in !== "number"
  ) {
    throw new Error("Shopify token refresh response is missing required token fields.");
  }

  await prisma.session.update({
    where: { id: session.id },
    data: {
      accessToken: refreshed.access_token,
      expires: new Date(Date.now() + refreshed.expires_in * 1000),
      refreshToken: refreshed.refresh_token,
      refreshTokenExpires: new Date(
        Date.now() + refreshed.refresh_token_expires_in * 1000,
      ),
    },
  });

  return refreshed.access_token;
}

function isCodeConnection(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(value.nodes) &&
    typeof value.pageInfo?.hasNextPage === "boolean"
  );
}

function isCodesCount(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.count === "number" &&
    typeof value.precision === "string"
  );
}

function asDate(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDiscount(node) {
  const discount = node.discount;
  const providerType = String(discount?.__typename ?? "UNKNOWN");
  const method = providerType.startsWith("DiscountAutomatic")
    ? "AUTOMATIC"
    : "CODE";

  const codes = isCodeConnection(discount?.codes) ? discount.codes : null;
  const codesCount = isCodesCount(discount?.codesCount)
    ? discount.codesCount
    : null;

  const codeCount =
    method === "CODE" && codesCount?.precision === "EXACT"
      ? codesCount.count
      : null;

  const codeNodes = codes?.nodes ?? [];

  const singleRedeemCode =
    codeCount === 1 &&
    codeNodes.length === 1 &&
    codes?.pageInfo.hasNextPage === false &&
    typeof codeNodes[0]?.code === "string" &&
    codeNodes[0].code.length > 0
      ? codeNodes[0].code
      : null;

  const fixedSelectable =
    method === "AUTOMATIC"
      ? !providerType.includes("App")
      : !providerType.includes("App") &&
        codeCount === 1 &&
        singleRedeemCode !== null;

  return {
    shopifyDiscountNodeId: node.id,
    providerType,
    method,
    providerStatus: String(discount?.status ?? "UNKNOWN"),
    title: String(discount?.title ?? "Untitled discount"),
    summary: typeof discount?.summary === "string" ? discount.summary : null,
    startsAt: asDate(discount?.startsAt),
    endsAt: asDate(discount?.endsAt),
    codeCount,
    singleRedeemCode,
    fixedSelectable,
    providerSnapshot: {
      ...(discount ?? {}),
      id: node.id,
      codesCount,
      codes,
    },
  };
}

async function listDiscounts(shopDomain, accessToken) {
  const records = [];
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await fetch(
      `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: QUERY,
          variables: {
            first: PAGE_SIZE,
            after,
          },
        }),
      },
    );

    const raw = await response.text();
    let body;

    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(
        `Shopify discount GraphQL returned non-JSON (${response.status}): ${raw.slice(0, 500)}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Shopify discount GraphQL failed: HTTP ${response.status} ${JSON.stringify(body)}`,
      );
    }

    if (body.errors?.length) {
      throw new Error(
        `Shopify discount GraphQL errors: ${body.errors
          .map((error) => error.message ?? JSON.stringify(error))
          .join("; ")}`,
      );
    }

    const connection = body.data?.discountNodes;
    if (!connection) {
      throw new Error("Shopify discount GraphQL returned no discountNodes connection.");
    }

    for (const node of connection.nodes ?? []) {
      if (node?.discount) {
        records.push(normalizeDiscount(node));
      }
    }

    hasNextPage = connection.pageInfo?.hasNextPage === true;
    after = connection.pageInfo?.endCursor ?? null;

    if (hasNextPage && !after) {
      throw new Error(
        "Shopify reported another discount page but returned no endCursor.",
      );
    }
  }

  return records;
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : "";
}

function tableRows(discounts) {
  return discounts.map((discount) => ({
    status: discount.providerStatus,
    method: discount.method,
    title: discount.title,
    summary: discount.summary ?? "",
    code:
      discount.singleRedeemCode ??
      (discount.codeCount == null
        ? ""
        : discount.codeCount === 0
          ? "0 codes"
          : `${discount.codeCount} codes`),
    startsAt: iso(discount.startsAt),
    endsAt: iso(discount.endsAt),
    fixedSelectable: discount.fixedSelectable ? "YES" : "NO",
    providerType: discount.providerType,
  }));
}

async function main() {
  if (flag("help") || process.argv.length <= 2) {
    console.log(usage());
    return;
  }

  const shop = await resolveShop(arg("shop"));
  const token = await getShopifyAccessToken(shop.domain);
  const observed = await listDiscounts(shop.domain, token);

  let filtered = flag("all")
    ? observed
    : observed.filter((discount) => discount.providerStatus === "ACTIVE");

  if (flag("selectable-only")) {
    filtered = filtered.filter((discount) => discount.fixedSelectable);
  }

  filtered.sort((left, right) => {
    const title = left.title.localeCompare(right.title);
    if (title !== 0) return title;
    return left.shopifyDiscountNodeId.localeCompare(right.shopifyDiscountNodeId);
  });

  if (flag("json")) {
    console.log(
      JSON.stringify(
        {
          shop: {
            id: shop.id,
            domain: shop.domain,
            status: shop.status,
          },
          apiVersion: API_VERSION,
          filter: {
            activeOnly: !flag("all"),
            selectableOnly: flag("selectable-only"),
          },
          totalObserved: observed.length,
          returned: filtered.length,
          discounts: filtered.map((discount) => ({
            ...discount,
            startsAt: iso(discount.startsAt) || null,
            endsAt: iso(discount.endsAt) || null,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("");
  console.log("Shopify store discounts");
  console.log("=======================");
  console.log(`Shop: ${shop.domain}`);
  console.log(`Shop ID: ${shop.id}`);
  console.log(`Shop status: ${shop.status}`);
  console.log(`Shopify Admin API: ${API_VERSION}`);
  console.log(
    `Filter: ${flag("all") ? "all provider statuses" : "ACTIVE only"}${
      flag("selectable-only") ? ", Moda fixed-selectable only" : ""
    }`,
  );
  console.log(`Observed in Shopify: ${observed.length}`);
  console.log(`Displayed: ${filtered.length}`);
  console.log("");

  if (filtered.length === 0) {
    console.log("No matching Shopify discounts were found.");
    return;
  }

  console.table(tableRows(filtered));

  console.log("");
  console.log("Notes:");
  console.log("- summary is Shopify's human-readable summary where that discount type exposes one; app-owned discounts return a blank summary.");
  console.log("- fixedSelectable=YES means the current Moda provider logic can use it as a fixed recovery offer.");
  console.log("- app-owned automatic/code discounts are deliberately not fixed-selectable.");
  console.log("- for a code discount, Moda only exposes the literal code when Shopify reports exactly one code.");
}

main()
  .catch((error) => {
    console.error(
      `inspect-shop-discounts: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
