import { first, type SqlTransaction } from "./recovery-conversation.sql.js";
import { readRecoveryShopHeader, verifiedRecoveryShopHeader, hasPreparedRecoveryShopHeader } from "../conversation-wrappers/recovery-shop-header.js";
import { stableJson } from "../conversation-wrappers/projection.js";

/** Called only inside the existing Shop-locked final permit transaction. */
export async function currentRecoveryShopHeaderMatches(tx: SqlTransaction, raw: unknown, body: string | null, shopId: string): Promise<boolean> {
  const receipt = readRecoveryShopHeader(raw);
  if (!receipt || receipt.shopId !== shopId || !body || !hasPreparedRecoveryShopHeader(body, receipt)) return false;
  const shop = await first<{domain: string; status: string}>(tx, `SELECT "domain","status"::text FROM "commerce"."Shop" WHERE "id"=$1 FOR SHARE`, shopId);
  if (!shop || shop.status !== "ACTIVE") return false;
  const brand = await first<{brandName: string | null}>(tx, `SELECT "brandName" FROM "commerce"."ShopBrand" WHERE "shopId"=$1 FOR SHARE`, shopId);
  const current = verifiedRecoveryShopHeader(shopId, shop.domain, brand?.brandName);
  return current !== null && stableJson(current) === stableJson(receipt);
}
