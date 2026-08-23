import prisma  from "../lib/db.js";

type ShopifyRefreshResponse = {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  scope?: string;
};

export async function getShopifyAccessToken(
  shop: string,
): Promise<string> {
  const session =
    await prisma.session.findFirst({
      where: {
        shop,
        isOnline: false,
      },

      orderBy: {
        expires: "desc",
      },
    });

  if (!session) {
    throw new Error(
      `No offline Shopify session found for ${shop}`,
    );
  }

  if (!session.accessToken) {
    throw new Error(
      `Shopify session has no access token for ${shop}`,
    );
  }

  // Non-expiring offline token
  if (!session.expires) {
    return session.accessToken;
  }

  const now = new Date();

  // Still valid
  if (session.expires > now) {
    return session.accessToken;
  }

  // Expired and cannot be refreshed
  if (!session.refreshToken) {
    throw new Error(
      `Shopify access token expired and no refresh token exists for ${shop}`,
    );
  }

  return refreshShopifyAccessToken({
    sessionId: session.id,
    shop,
    refreshToken: session.refreshToken,
  });
}

async function refreshShopifyAccessToken({
  sessionId,
  shop,
  refreshToken,
}: {
  sessionId: string;
  shop: string;
  refreshToken: string;
}): Promise<string> {
  const clientId =
    process.env.SHOPIFY_API_KEY;

  const clientSecret =
    process.env.SHOPIFY_API_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Shopify API credentials are missing",
    );
  }

  const response = await fetch(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },

      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Failed to refresh Shopify access token: ${response.status} ${body}`,
    );
  }

  const refreshed =
    (await response.json()) as ShopifyRefreshResponse;

  const accessTokenExpires =
    new Date(
      Date.now() +
        refreshed.expires_in * 1000,
    );

  const refreshTokenExpires =
    new Date(
      Date.now() +
        refreshed.refresh_token_expires_in *
          1000,
    );

  await prisma.session.update({
    where: {
      id: sessionId,
    },

    data: {
      accessToken:
        refreshed.access_token,

      expires:
        accessTokenExpires,

      refreshToken:
        refreshed.refresh_token,

      refreshTokenExpires,
    },
  });

  return refreshed.access_token;
}