import prisma from "../lib/db.js";


export async function getShopifySession(
  shop: string,
) {
  const session = await prisma.session.findFirst({
    where: {
      shop,
      isOnline: false,
    },
  });

  if (!session) {
    throw new Error(
      `No offline Shopify session found for ${shop}`,
    );
  }

  return session;
}

export async function getShopifyAccessToken(
  shop: string,
): Promise<string> {
  const session =
    await getShopifySession(shop);

  if (
    session.expires &&
    session.expires <= new Date()
  ) {
    throw new Error(
      `Shopify access token has expired for ${shop}`,
    );
  }

  return session.accessToken;
}