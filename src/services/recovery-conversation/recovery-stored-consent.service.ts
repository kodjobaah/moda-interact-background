import type { PrismaClient } from "@prisma/client";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { canonicalWhatsAppSender } from "../whatsapp-contact-opt-out/phone.js";
import {
  ShopifyWhatsAppConsentService,
  type ShopifyWhatsAppConsentServicePort,
} from "../shopify-whatsapp-consent.service.js";
import {
  rows,
  type RecoveryContext,
  type SqlTransaction,
} from "./recovery-conversation.sql.js";
import {
  wooRecoveryConsentReader,
  type WooRecoveryConsentReaderPort,
  type WooRecoveryConsentSnapshot,
} from "../woocommerce-recovery-consent.service.js";

/** A pre-provider snapshot, deliberately not a persistent permission token.
 * The final Shop-locked SQL fence checks the same phone and both revisions.
 */
export type StoredRecoveryConsentSnapshot = {
  customerPhoneId: string;
  canonicalRecipient: string;
  consentRevision: bigint;
  noContactRevision: bigint;
  /** Present only for WooCommerce; its installation and decision identity are
   * required again inside the shared proactive dispatch transaction. */
  woo?: WooRecoveryConsentSnapshot;
};

export type StoredRecoveryConsentDecision =
  | { kind: "allowed"; snapshot: StoredRecoveryConsentSnapshot | null }
  | { kind: "denied"; reason: string };

export type StoredRecoveryConsentReader = Pick<
  RecoveryStoredConsentService,
  "preflight"
>;
const storedConsentLogger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export class RecoveryStoredConsentService {
  constructor(
    private readonly database: Pick<PrismaClient, "checkoutRecovery"> = prisma,
    private readonly shopify: Pick<
      ShopifyWhatsAppConsentServicePort,
      "evaluateStoredRecipient"
    > = new ShopifyWhatsAppConsentService(),
    private readonly logger: Pick<
      StructuredLogger,
      "info" | "warn" | "error"
    > = storedConsentLogger,
    private readonly woo: Pick<
      WooRecoveryConsentReaderPort,
      "evaluateStoredRecipient"
    > = wooRecoveryConsentReader,
  ) {}

  /** No provider read: new checkout verification belongs to admission. The
   * existing multipart reply path is not proactive marketing. Preserve its
   * Woo service-window/STOP policy; Shopify keeps its existing consent check. */
  async preflight(input: {
    shopId: string;
    recoveryId: string;
    recipient: string;
    purpose?: "multipart-reply";
  }): Promise<StoredRecoveryConsentDecision> {
    let platform: string | undefined;
    try {
      const recovery = await this.database.checkoutRecovery.findUnique({
        where: { id: input.recoveryId },
        select: {
          shopId: true,
          customerId: true,
          shop: { select: { platform: true } },
        },
      });
      if (!recovery || recovery.shopId !== input.shopId)
        return { kind: "denied", reason: "recovery-unavailable" };
      platform = recovery.shop.platform;
      if (recovery.shop.platform === "WOOCOMMERCE") {
        if (input.purpose === "multipart-reply")
          return { kind: "allowed", snapshot: null };
        if (!recovery.customerId)
          return { kind: "denied", reason: "stored-consent-unavailable" };
        const canonical = canonicalWhatsAppSender(input.recipient);
        if (!canonical)
          return { kind: "denied", reason: "recipient-unverified" };
        const decision = await this.woo.evaluateStoredRecipient({
          shopId: input.shopId,
          customerId: recovery.customerId,
          recipient: `+${canonical}`,
        });
        if (decision.status !== "ALLOWED")
          return {
            kind: "denied",
            reason:
              decision.status === "UNAVAILABLE"
                ? "stored-consent-unavailable"
                : "stored-consent-denied",
          };
        const snapshot = decision.snapshot;
        if (
          decision.canonicalRecipient !== canonical ||
          snapshot.canonicalRecipient !== canonical ||
          snapshot.shopId !== input.shopId ||
          snapshot.customerId !== recovery.customerId ||
          snapshot.customerPhoneId !== decision.customerPhoneId ||
          snapshot.consentRevision !== decision.consentRevision ||
          snapshot.noContactRevision !== decision.noContactRevision
        )
          return { kind: "denied", reason: "recipient-changed" };
        return {
          kind: "allowed",
          snapshot: {
            customerPhoneId: snapshot.customerPhoneId,
            canonicalRecipient: snapshot.canonicalRecipient,
            consentRevision: snapshot.consentRevision,
            noContactRevision: snapshot.noContactRevision,
            woo: snapshot,
          },
        };
      }
      if (recovery.shop.platform !== "SHOPIFY" || !recovery.customerId)
        return { kind: "denied", reason: "stored-consent-unavailable" };
      const canonical = canonicalWhatsAppSender(input.recipient);
      if (!canonical) return { kind: "denied", reason: "recipient-unverified" };
      const decision = await this.shopify.evaluateStoredRecipient({
        // Preserve the explicit international identity across the consent boundary.
        shopId: input.shopId,
        customerId: recovery.customerId,
        recipient: `+${canonical}`,
      });
      if (decision.status !== "ALLOWED")
        return {
          kind: "denied",
          reason:
            decision.status === "UNAVAILABLE"
              ? "stored-consent-unavailable"
              : "stored-consent-denied",
        };
      if (decision.canonicalRecipient !== canonical)
        return { kind: "denied", reason: "recipient-changed" };
      return {
        kind: "allowed",
        snapshot: {
          customerPhoneId: decision.customerPhoneId,
          canonicalRecipient: decision.canonicalRecipient,
          consentRevision: decision.consentRevision,
          noContactRevision: decision.noContactRevision,
        },
      };
    } catch (error) {
      this.logger.error(
        platform === "WOOCOMMERCE"
          ? "woocommerce.consent.outbound.blocked"
          : "shopify.consent.outbound.blocked",
        {
          shopId: input.shopId,
          recoveryId: input.recoveryId,
          operation: "proactive_final_send",
          stage: "consent_preflight",
          outcome: "blocked_unavailable",
          reasonCode: "STORED_CONSENT_LOOKUP_FAILED",
          error,
        },
      );
      return { kind: "denied", reason: "stored-consent-unavailable" };
    }
  }
}

export const recoveryStoredConsentService = new RecoveryStoredConsentService();

type PhoneFenceRow = {
  id: string;
  whatsappCanonicalPhone: string | null;
  whatsappConsentPurpose: string;
  whatsappConsentDecision: string;
  whatsappConsentSource: string | null;
  whatsappConsentVerifiedAt: Date | null;
  whatsappConsentProviderObservedAt: Date | null;
  whatsappPhoneVerifiedAt: Date | null;
  whatsappConsentRevision: bigint;
  whatsappConsentDecisionSequence: bigint;
  whatsappNoContact: boolean;
  whatsappNoContactReason: string | null;
  whatsappNoContactRevision: bigint;
};

/** Must run after the Shop lock, in the same short SQL transaction as the
 * provider-dispatch permit. No provider, Redis or outside-network operations.
 */
export async function checkFinalStoredRecoveryConsent(
  tx: SqlTransaction,
  context: RecoveryContext,
  recipient: string,
  snapshot: StoredRecoveryConsentSnapshot | undefined,
): Promise<string | null> {
  if (!snapshot || snapshot.woo) return "stored-consent-snapshot-missing";
  const canonical = canonicalWhatsAppSender(recipient);
  if (!canonical || canonical !== snapshot.canonicalRecipient)
    return "recipient-changed";
  const phones = await rows<PhoneFenceRow>(
    tx,
    `
    SELECT p."id", p."whatsappCanonicalPhone", p."whatsappConsentPurpose"::text,
      p."whatsappConsentDecision"::text, p."whatsappConsentSource"::text,
      p."whatsappConsentVerifiedAt", p."whatsappConsentProviderObservedAt", p."whatsappPhoneVerifiedAt",
      p."whatsappConsentRevision", p."whatsappConsentDecisionSequence",
      p."whatsappNoContact", p."whatsappNoContactReason"::text, p."whatsappNoContactRevision"
    FROM "commerce"."CheckoutRecovery" r
    JOIN "commerce"."Customer" c ON c."id"=r."customerId" AND c."shopId"=r."shopId"
    JOIN "commerce"."CustomerPhone" p ON p."customerId"=c."id" AND p."endedAt" IS NULL
    WHERE r."id"=$1 AND r."shopId"=$2 AND p."whatsappCanonicalPhone"=$3
    ORDER BY p."id" LIMIT 2 FOR SHARE OF p`,
    context.recoveryId,
    context.shopId,
    canonical,
  );
  if (phones.length !== 1) return "stored-consent-ambiguous";
  const phone = phones[0]!;
  if (
    phone.id !== snapshot.customerPhoneId ||
    phone.whatsappCanonicalPhone !== canonical
  )
    return "recipient-changed";
  if (
    phone.whatsappConsentRevision !== snapshot.consentRevision ||
    phone.whatsappNoContactRevision !== snapshot.noContactRevision
  )
    return "stored-consent-revision-changed";
  if (phone.whatsappNoContact || phone.whatsappNoContactReason !== null)
    return "local-no-contact";
  if (
    phone.whatsappConsentPurpose !== "WHATSAPP_CHECKOUT_RECOVERY" ||
    phone.whatsappConsentDecision !== "GRANTED" ||
    phone.whatsappConsentSource !== "SHOPIFY_NATIVE" ||
    phone.whatsappConsentRevision <= 0n ||
    phone.whatsappConsentDecisionSequence <= 0n ||
    !phone.whatsappConsentVerifiedAt ||
    !phone.whatsappConsentProviderObservedAt ||
    !phone.whatsappPhoneVerifiedAt ||
    phone.whatsappConsentVerifiedAt < phone.whatsappConsentProviderObservedAt ||
    phone.whatsappConsentVerifiedAt < phone.whatsappPhoneVerifiedAt
  )
    return "stored-consent-denied";
  // The final shop-locked dispatch permit must not infer GRANT from an
  // unaudited CustomerPhone projection. Check the current immutable evidence.
  const evidence = await rows<{ matched: boolean }>(
    tx,
    `
    SELECT EXISTS (
      SELECT 1 FROM "commerce"."WhatsAppConsentEvidence" e
      WHERE e."shopId"=$1 AND e."customerPhoneId"=$2
        AND e."customerId"=(SELECT "customerId" FROM "commerce"."CheckoutRecovery" WHERE "id"=$7 AND "shopId"=$1)
        AND e."installationId" IS NULL AND e."canonicalPhone"=$3
        AND e."decision"='GRANT'
        AND e."phoneConsentRevision"=$4 AND e."decisionSequence"=$5
        AND e."decisionAt"=$6
    ) AS "matched"`,
    context.shopId,
    phone.id,
    canonical,
    phone.whatsappConsentRevision,
    phone.whatsappConsentDecisionSequence,
    phone.whatsappConsentProviderObservedAt,
    context.recoveryId,
  );
  if (!evidence[0]?.matched) return "stored-consent-evidence-missing";
  return null;
}
