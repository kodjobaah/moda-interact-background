import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma } from "@prisma/client";
import type { WooRecoveryConsentSnapshot } from "../woocommerce-recovery-consent.service.js";
import type { WooBasketEvidence, WooPendingCandidate } from "./contracts.js";
import type { WooActivityWatermark } from "./woo-activity-watermark.store.js";

type AdmissionFenceRow = {
  customerId: string;
  customerPhoneId: string;
  customerShopId: string;
  customerEmail: string | null;
  canonicalPhone: string | null;
  endedAt: Date | null;
  shopStatus: string;
  shopPlatform: string;
  installationId: string;
  installationStatus: string;
  revokedAt: Date | null;
  credentialVersion: number;
  canonicalSiteUrl: string;
  shopDomain: string;
  phoneVerifiedAt: Date | null;
  consentPurpose: string;
  consentDecision: string;
  consentSource: string | null;
  consentVerifiedAt: Date | null;
  providerObservedAt: Date | null;
  consentRevision: bigint;
  decisionSequence: bigint;
  noContact: boolean;
  noContactReason: string | null;
  noContactRevision: bigint;
};

export const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;
export const SHOP_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MONEY = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/;

export function anonymousId(value: string): string {
  // Stable correlation without emitting a potentially sensitive event/job key.
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function validActivity(value: string): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date : null;
}

function validMoney(value: unknown): value is string {
  return typeof value === "string" && MONEY.test(value);
}

export function validBasket(basket: WooBasketEvidence): basket is Extract<WooBasketEvidence, { kind: "nonempty" }> {
  if (!basket || basket.kind !== "nonempty" || !basket.checkout) return false;
  const { checkout } = basket;
  return Array.isArray(checkout.items) && checkout.items.length > 0 && checkout.items.length <= 50 &&
    typeof checkout.currency === "string" && /^[A-Z]{3}$/.test(checkout.currency) &&
    validMoney(checkout.total) &&
    checkout.items.every((item) =>
      item && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 100_000 &&
      [item.productId, item.variationId, item.sku, item.title].some(
        (value) => typeof value === "string" && value.length > 0 && value.length <= 200,
      ) &&
      (item.unitPrice === undefined || validMoney(item.unitPrice)) &&
      (item.total === undefined || validMoney(item.total)),
    );
}

export function sameAcceptedCandidate(expected: WooPendingCandidate, current: WooPendingCandidate): boolean {
  // Comparing only timestamps is not enough for same-second conflicts.
  return current.source === "woocommerce" &&
    current.shopId === expected.shopId && current.checkoutToken === expected.checkoutToken &&
    Number.isSafeInteger(expected.generation) && expected.generation! > 0 &&
    current.generation === expected.generation &&
    current.lastEventId === expected.lastEventId &&
    current.lastActivityAt === expected.lastActivityAt &&
    isDeepStrictEqual(current.basket, expected.basket);
}

/** The activity watermark is the accepted event fence; the queue/index alone is
 * not sufficient evidence when stale or partially-written Redis state exists. */
export function matchesAcceptedWatermark(
  candidate: WooPendingCandidate,
  watermark: WooActivityWatermark | null,
): boolean {
  if (!watermark || !Number.isSafeInteger(candidate.generation) || (candidate.generation ?? 0) < 1) return false;
  const state = candidate.basket.kind === "nonempty" ? "nonempty" : candidate.basket.kind;
  const digest = candidate.basket.kind === "nonempty"
    ? createHash("sha256").update(JSON.stringify(candidate.basket.checkout)).digest("hex")
    : "0".repeat(64);
  return watermark.generation === candidate.generation &&
    watermark.lastEventId === candidate.lastEventId &&
    watermark.lastActivityAt === candidate.lastActivityAt &&
    watermark.checkoutDigest === digest && watermark.state === state;
}

export function emailConflicts(observed: string | undefined, stored: string | null): boolean {
  return !!observed && !!stored && observed.trim().toLowerCase() !== stored.trim().toLowerCase();
}

function currentConsentStillValid(
  row: AdmissionFenceRow | undefined,
  expected: WooRecoveryConsentSnapshot,
  observedEmail: string | undefined,
  expectedSite?: { canonicalSiteUrl: string; shopDomain: string },
): boolean {
  if (!row || row.customerId !== expected.customerId || row.customerPhoneId !== expected.customerPhoneId ||
    row.customerShopId !== expected.shopId || row.shopStatus !== "ACTIVE" || row.shopPlatform !== "WOOCOMMERCE" ||
    row.installationId !== expected.installationId || row.installationStatus !== "ACTIVE" || row.revokedAt ||
    row.credentialVersion !== expected.credentialVersion ||
    (expectedSite && (row.canonicalSiteUrl !== expectedSite.canonicalSiteUrl ||
      row.shopDomain !== expectedSite.shopDomain)) || row.endedAt ||
    row.canonicalPhone !== expected.canonicalRecipient || emailConflicts(observedEmail, row.customerEmail) ||
    row.noContact || row.noContactReason !== null || row.noContactRevision !== expected.noContactRevision ||
    row.consentRevision !== expected.consentRevision || row.decisionSequence !== expected.consentDecisionSequence ||
    row.consentRevision <= 0n || row.decisionSequence <= 0n ||
    row.consentPurpose !== "WHATSAPP_CHECKOUT_RECOVERY" ||
    row.consentDecision !== "GRANTED" || row.consentSource !== "WOO_MODA_CHECKBOX" ||
    !row.phoneVerifiedAt || !row.consentVerifiedAt || !row.providerObservedAt ||
    row.consentVerifiedAt < row.phoneVerifiedAt || row.consentVerifiedAt < row.providerObservedAt) {
    return false;
  }
  return true;
}

/** Lock the current recipient/consent/installation rows until the INSERT commits.
 * No external reads or queue/Redis traffic occur in this transaction. */
export async function confirmCurrentWooConsent(
  tx: Prisma.TransactionClient,
  shopId: string,
  snapshot: WooRecoveryConsentSnapshot,
  observedEmail: string | undefined,
  expectedSite?: { canonicalSiteUrl: string; shopDomain: string },
): Promise<boolean> {
  const fences = await tx.$queryRaw<AdmissionFenceRow[]>(Prisma.sql`
          SELECT cp."id" AS "customerPhoneId", cp."customerId", c."shopId" AS "customerShopId",
            c."email" AS "customerEmail", cp."whatsappCanonicalPhone" AS "canonicalPhone", cp."endedAt",
            s."status"::text AS "shopStatus", s."platform"::text AS "shopPlatform",
            i."id" AS "installationId", i."status"::text AS "installationStatus",
            i."revokedAt", i."credentialVersion", i."canonicalSiteUrl",
            s."domain" AS "shopDomain",
            cp."whatsappPhoneVerifiedAt" AS "phoneVerifiedAt",
            cp."whatsappConsentPurpose"::text AS "consentPurpose",
            cp."whatsappConsentDecision"::text AS "consentDecision",
            cp."whatsappConsentSource"::text AS "consentSource",
            cp."whatsappConsentVerifiedAt" AS "consentVerifiedAt",
            cp."whatsappConsentProviderObservedAt" AS "providerObservedAt",
            cp."whatsappConsentRevision" AS "consentRevision",
            cp."whatsappConsentDecisionSequence" AS "decisionSequence",
            cp."whatsappNoContact" AS "noContact",
            cp."whatsappNoContactReason"::text AS "noContactReason",
            cp."whatsappNoContactRevision" AS "noContactRevision"
          FROM "commerce"."CustomerPhone" cp
          JOIN "commerce"."Customer" c ON c."id" = cp."customerId"
          JOIN "commerce"."Shop" s ON s."id" = c."shopId"
          JOIN "woocommerce"."WooCommerceInstallation" i ON i."shopId" = s."id"
          WHERE cp."id" = ${snapshot.customerPhoneId} AND c."id" = ${snapshot.customerId}
            AND s."id" = ${shopId}
          FOR SHARE OF cp, c, s, i
  `);
  return fences.length === 1 && currentConsentStillValid(fences[0], snapshot, observedEmail, expectedSite);
}
