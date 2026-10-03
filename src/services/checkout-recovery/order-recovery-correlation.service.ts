import type { PrismaClient } from "@prisma/client";
import type { pendingRecoveryCandidateService } from "../pending-recovery-candidate.service.js";

export interface RecoveryOrderCompletionInput {
  shop: string;
  orderId: string;
  checkoutToken: string | null;
  cartToken: string | null;
  customerId: string | null;
  totalPrice: string | null;
  currency: string | null;
  completedAt: string | null;
}

type PendingRecoveryCandidatePort = Pick<
  typeof pendingRecoveryCandidateService,
  "resolveCandidate" | "withCheckoutLock" | "cancelCandidate" | "markOrderProcessed"
>;

export class OrderRecoveryCorrelationService {
  constructor(
    private readonly database: PrismaClient,
    private readonly pendingRecoveryCandidateService: PendingRecoveryCandidatePort,
  ) {}

  async handleOrderCompleted(event: RecoveryOrderCompletionInput) {
    if (!event.checkoutToken && !event.cartToken) {
      return { kind: "ignored", reason: "missing-correlation" } as const;
    }

    const shop = await this.database.shop.findUnique({
      where: { domain: event.shop },
      select: { id: true, status: true },
    });

    if (!shop) {
      return { kind: "ignored", reason: "shop-not-found" } as const;
    }
    if (shop.status !== "ACTIVE") {
      return { kind: "ignored", reason: "shop-unavailable" } as const;
    }

    let checkoutTokenForScope = event.checkoutToken;
    if (!checkoutTokenForScope) {
      const cartOnly = await this.pendingRecoveryCandidateService.resolveCandidate({
        shopId: shop.id,
        checkoutToken: null,
        cartToken: event.cartToken,
      });

      if (!cartOnly) {
        return { kind: "discarded", reason: "no-checkout-token" } as const;
      }

      checkoutTokenForScope = cartOnly.candidate.checkoutToken;
    }

    return this.pendingRecoveryCandidateService.withCheckoutLock(
      shop.id,
      checkoutTokenForScope,
      async () => {
        const matched = await this.pendingRecoveryCandidateService.resolveCandidate({
          shopId: shop.id,
          checkoutToken: checkoutTokenForScope,
          cartToken: event.cartToken,
        });

        if (matched) {
          await this.pendingRecoveryCandidateService.cancelCandidate(matched);
          await this.pendingRecoveryCandidateService.markOrderProcessed(
            shop.id,
            matched.candidate.checkoutToken,
          );
          return {
            kind: "cancelled-candidate",
            checkoutToken: matched.candidate.checkoutToken,
          } as const;
        }

        const checkoutToken = event.checkoutToken as string | null;
        if (!checkoutToken) {
          return { kind: "discarded", reason: "no-checkout-token" } as const;
        }

        await this.pendingRecoveryCandidateService.markOrderProcessed(
          shop.id,
          checkoutToken,
        );

        return this.database.$transaction(async (transaction) => {
          const recovery = await transaction.checkoutRecovery.findFirst({
            where: { shopId: shop.id, checkoutToken },
            orderBy: [{ generation: "desc" }, { id: "desc" }],
            select: { id: true, status: true, generation: true },
          });

          if (!recovery) {
            return { kind: "discarded", reason: "recovery-not-found" } as const;
          }

          if (["COMPLETED", "EXPIRED", "CANCELLED"].includes(recovery.status)) {
            return {
              kind: "ignored",
              reason: `terminal-${recovery.status.toLowerCase()}`,
            } as const;
          }

          const completedAt = new Date(
            event.completedAt ?? new Date().toISOString(),
          );

          const updated = await transaction.checkoutRecovery.updateMany({
            where: {
              id: recovery.id,
              status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] },
            },
            data: {
              status: "COMPLETED",
              completedAt,
              admissionBlockedAt: null,
              admissionBlockReason: null,
            },
          });

          if (updated.count === 0) {
            return { kind: "ignored", reason: "already-transitioned" } as const;
          }

          await transaction.checkoutRecoveryStatusHistory.create({
            data: {
              checkoutRecoveryId: recovery.id,
              fromStatus: recovery.status,
              toStatus: "COMPLETED",
              reason: "Order completed",
              source: "shopify.orders.create",
              metadata: event.customerId
                ? { orderId: event.orderId, customerId: event.customerId }
                : { orderId: event.orderId },
              occurredAt: completedAt,
            },
          });

          return {
            kind: "completed",
            recoveryId: recovery.id,
            fromStatus: recovery.status,
          } as const;
        });
      },
    );
  }
}