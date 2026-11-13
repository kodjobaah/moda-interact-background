import { canonicalJson, commerceStoreHostname } from "@modainteract/moda-interact-shared/commerce";
import { buildConversationBrandImageDeliveryPlan, ConversationPreparedBrandImageSchema,
  type ConversationDeliveryPlan, type ConversationMediaDeliveryPlan, type ConversationPreparedBrandImage } from "@modainteract/moda-interact-shared/commerce/presentation";
import { verifiedReadyConversationBrandImage } from "./shop-brand-media-runtime/resolver.js";
import { first, type SqlTransaction } from "./recovery-conversation/recovery-conversation.sql.js";
import { platformConsumerConfiguration } from "./platform-configuration/consumers.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { ShopBrandReadyMediaAdapter } from "./shop-brand-media-runtime/resolver.js";
export type BrandMediaPolicyRef = Readonly<{environment: string; key: 'shopBrand.publicMedia'; id: string; version: number; publicOrigin: string}>;
export function readBrandMediaPolicyRef(raw: unknown): BrandMediaPolicyRef | null {
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
 const r = raw as Record<string, unknown>;
 if(Object.keys(r).length!==5 || r.environment!==resolveDeploymentEnvironmentName() || r.key!=='shopBrand.publicMedia' || typeof r.id!=='string' || !r.id || r.id.length>256 || !Number.isSafeInteger(r.version) || Number(r.version)<1 || typeof r.publicOrigin!=='string') return null;
 try {const u=new URL(r.publicOrigin);if(u.protocol!=='https:'||u.origin!==r.publicOrigin||u.username||u.password)return null;}catch{return null;}
 return r as BrandMediaPolicyRef;
}
export type ConversationLogoResolution = {image: ConversationPreparedBrandImage; policyRef: BrandMediaPolicyRef};
export type ConversationLogoResolver = (shopId: string, role?: "LOGO" | "SQUARE_LOGO") => Promise<ConversationLogoResolution | null>;
export const resolveConversationLogo: ConversationLogoResolver = async (shopId, role) => {
 const snapshot=await platformConsumerConfiguration.read('shopBrand.publicMedia');
 const environment=resolveDeploymentEnvironmentName();
 if(!snapshot.rowId) return null;
 const image=await new ShopBrandReadyMediaAdapter(undefined,async()=>snapshot.value).resolveConversationLogo(shopId,role);
 return image ? {image,policyRef:{environment,key:'shopBrand.publicMedia',id:snapshot.rowId,version:snapshot.version,publicOrigin:image.publicOrigin}} : null;
};

/** Only new known-recovery preparation; absent/invalid media preserves the full original plan/body. */
export async function prepareRecoveryBrandPlan(input: {shopId: string; body: string; header?: import("./recovery-multipart/common-layout.js").RecoveryLayoutReceipt | undefined;
  plan?: ConversationDeliveryPlan | undefined; onPolicy?: (ref: BrandMediaPolicyRef)=>void}, resolve: ConversationLogoResolver = resolveConversationLogo): Promise<ConversationMediaDeliveryPlan | undefined> {
  if (!input.header || input.header.shopId !== input.shopId || input.plan?.kind === "IMAGE" || Array.from(input.body).length > 1024) return input.plan;
  try {
    const resolved = await resolve(input.shopId);
    const image=resolved?.image; const policy=readBrandMediaPolicyRef(resolved?.policyRef);
    if (!image || !policy || policy.publicOrigin!==image.publicOrigin || image.origin.shopId !== input.shopId || !["LOGO", "SQUARE_LOGO"].includes(image.origin.role) ||
        commerceStoreHostname(input.header.schemaVersion===2?input.header.variables['shop.websiteUrl']:input.header.websiteUrl) !== image.origin.shopDomain) return input.plan;
    const selected = buildConversationBrandImageDeliveryPlan({plan: input.plan ?? {schemaVersion: 1, kind: "TEXT", body: input.body},
      origin: image.origin, publicOrigin: image.publicOrigin, image});
    if(selected.plan.kind === "BRAND_IMAGE") input.onPolicy?.(policy);
    return selected.plan;
  } catch { return input.plan; } // Optional image/config failure cannot discard the complete text.
}

/** Revalidation never substitutes another image or text after immutable preparation. */
export async function frozenBrandPlanCurrent(plan: ConversationMediaDeliveryPlan,
  resolve: ConversationLogoResolver = resolveConversationLogo): Promise<boolean> {
  if (plan.kind !== "BRAND_IMAGE") return true;
  if (plan.image.origin.role === "COVER_IMAGE") return false;
  try { return canonicalJson((await resolve(plan.image.origin.shopId, plan.image.origin.role))?.image) === canonicalJson(plan.image); } catch { return false; }
}

/** DB-only authoritative final check; caller already holds Shop and we share-lock its brand row. */
export async function currentBrandPlanMatches(tx: SqlTransaction, plan: ConversationMediaDeliveryPlan, shopId: string, policyRef?: BrandMediaPolicyRef): Promise<boolean> {
  if (plan.kind !== "BRAND_IMAGE") return true;
  const policy=readBrandMediaPolicyRef(policyRef);
  if(!policy || policy.publicOrigin!==plan.image.publicOrigin) return false;
  const config=await first<{id:string;version:number}>(tx,`SELECT "id","version" FROM "public"."PlatformConfiguration" WHERE "environment"=$1 AND "key"='shopBrand.publicMedia' FOR SHARE`,resolveDeploymentEnvironmentName());
  if(!config || config.id!==policy.id || config.version!==policy.version) return false;
  if (!ConversationPreparedBrandImageSchema.safeParse(plan.image).success || plan.image.origin.shopId !== shopId ||
      !["LOGO", "SQUARE_LOGO"].includes(plan.image.origin.role)) return false;
  const shop = await first<{domain: string; status: string}>(tx, `SELECT "domain","status"::text FROM "commerce"."Shop" WHERE "id"=$1 FOR SHARE`, shopId);
  const brand = await first<{whatsAppMedia: unknown}>(tx, `SELECT "whatsAppMedia" FROM "commerce"."ShopBrand" WHERE "shopId"=$1 FOR SHARE`, shopId);
  if (!shop || shop.status !== "ACTIVE" || !brand) return false;
  const current = verifiedReadyConversationBrandImage({shopId, domain: shop.domain, role: plan.image.origin.role,
    whatsAppMedia: brand.whatsAppMedia, publicOrigin: new URL(plan.image.publicOrigin)});
  return current !== null && canonicalJson(current) === canonicalJson(plan.image);
}
