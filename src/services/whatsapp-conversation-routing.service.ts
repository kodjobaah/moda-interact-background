import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import prisma from "../lib/db.js";
import { shopExecutionEligibilityService } from "./shop-execution-eligibility.service.js";
import { whatsAppService } from "./whatsapp.service.js";

export type RoutingGuidanceReason =
  | "UNKNOWN_OWNER"
  | "AMBIGUOUS_OWNER"
  | "CONTEXT_REQUIRED"
  | "INVALID_REFERENCE"
  | "SHOP_UNAVAILABLE";

export type ConversationRoute =
  | {
      kind: "resolved";
      conversationId: string;
      shopId: string;
      customerId: string;
    }
  | { kind: "guidance"; reason: RoutingGuidanceReason }
  | { kind: "ignored" };

type ConversationOwner = {
  shopId: string;
  customerId: string;
};

type ExistingConversationOwner = ConversationOwner & {
  recoveryLinked: boolean;
};

export const canonicalPhone = (phone: string) =>
  phone.trim().replace(/^\+/, "");

const phoneVariants = (phone: string): string[] => {
  const canonical = canonicalPhone(phone);
  return canonical ? [canonical, `+${canonical}`] : [];
};

export class WhatsAppConversationRoutingService {
  async resolveInboundMessage(
    event: WhatsAppInboundEvent,
  ): Promise<ConversationRoute> {
    const sender = whatsAppService.resolveSender();
    if (
      event.providerAccountId !== sender.providerAccountId ||
      event.providerPhoneNumberId !== sender.providerPhoneNumberId
    ) {
      return { kind: "ignored" };
    }

    const phone = canonicalPhone(event.customerPhone);
    const stored = await prisma.conversationMessage.findUnique({
      where: { providerMessageId: event.providerMessageId },
      select: { conversationId: true, direction: true },
    });

    if (stored && stored.direction !== "INBOUND") {
      return { kind: "guidance", reason: "INVALID_REFERENCE" };
    }

    if (event.contextMessageId) {
      const original = await prisma.conversationMessage.findUnique({
        where: { providerMessageId: event.contextMessageId },
        select: {
          direction: true,
          sentAt: true,
          conversationId: true,
        },
      });

      if (
        !original ||
        original.direction !== "OUTBOUND" ||
        !original.sentAt ||
        (stored && stored.conversationId !== original.conversationId)
      ) {
        return { kind: "guidance", reason: "INVALID_REFERENCE" };
      }

      return this.resolveExistingConversation(original.conversationId, phone);
    }

    if (stored) {
      return this.resolveExistingConversation(stored.conversationId, phone);
    }

    const ownerResult = await this.resolveCurrentOwner(phone);
    if (ownerResult.kind !== "owner") {
      return {
        kind: "guidance",
        reason:
          ownerResult.kind === "ambiguous"
            ? "AMBIGUOUS_OWNER"
            : "UNKNOWN_OWNER",
      };
    }

    const { shopId, customerId } = ownerResult.owner;

    // B remains behaviour-safe while Commerce execution is still recovery-bound.
    // Resolve a unique existing recovery conversation now; C will enable the
    // already-owned standalone path without changing the routing identity model.
    const recoveryConversations = await prisma.conversation.findMany({
      where: {
        checkoutRecovery: {
          is: {
            shopId,
            customerId,
          },
        },
        messages: {
          some: {
            direction: "OUTBOUND",
            providerMessageId: { not: null },
            sentAt: { not: null },
          },
        },
      },
      select: { id: true },
      take: 2,
    });

    if (recoveryConversations.length !== 1) {
      return { kind: "guidance", reason: "CONTEXT_REQUIRED" };
    }

    if (!(await shopExecutionEligibilityService.isShopExecutionActive(shopId))) {
      return { kind: "guidance", reason: "SHOP_UNAVAILABLE" };
    }

    return {
      kind: "resolved",
      conversationId: recoveryConversations[0]!.id,
      shopId,
      customerId,
    };
  }

  private async resolveExistingConversation(
    conversationId: string,
    phone: string,
  ): Promise<ConversationRoute> {
    const owner = await this.loadConversationOwner(conversationId);
    if (!owner || !(await this.phoneBelongsToCustomer(owner.customerId, phone))) {
      return { kind: "guidance", reason: "INVALID_REFERENCE" };
    }

    if (!(await shopExecutionEligibilityService.isShopExecutionActive(owner.shopId))) {
      return { kind: "guidance", reason: "SHOP_UNAVAILABLE" };
    }

    // B resolves generic ownership, but standalone Commerce execution remains
    // gated until C removes the recovery-specific agent/MCP identity.
    if (!owner.recoveryLinked) {
      return { kind: "guidance", reason: "CONTEXT_REQUIRED" };
    }

    return {
      kind: "resolved",
      conversationId,
      shopId: owner.shopId,
      customerId: owner.customerId,
    };
  }

  private async loadConversationOwner(
    conversationId: string,
  ): Promise<ExistingConversationOwner | null> {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        shopId: true,
        customerId: true,
        checkoutRecovery: {
          select: {
            shopId: true,
            customerId: true,
          },
        },
      },
    });

    if (!conversation) return null;

    const shopId = conversation.checkoutRecovery?.shopId ?? conversation.shopId;
    const customerId =
      conversation.checkoutRecovery?.customerId ?? conversation.customerId;

    if (!shopId || !customerId) return null;

    return {
      shopId,
      customerId,
      recoveryLinked: conversation.checkoutRecovery !== null,
    };
  }

  private async phoneBelongsToCustomer(
    customerId: string,
    phone: string,
  ): Promise<boolean> {
    const variants = phoneVariants(phone);
    if (variants.length === 0) return false;

    const current = await prisma.customerPhone.findFirst({
      where: {
        customerId,
        endedAt: null,
        phone: { in: variants },
      },
      select: { id: true },
    });
    if (current) return true;

    // Keep compatibility with historical Customer.phone rows that predate the
    // current-phone relation. New routing ownership is still based on the
    // current CustomerPhone relation whenever it exists.
    const legacy = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { phone: true },
    });
    return canonicalPhone(legacy?.phone ?? "") === phone;
  }

  private async resolveCurrentOwner(
    phone: string,
  ): Promise<
    | { kind: "owner"; owner: ConversationOwner }
    | { kind: "unknown" }
    | { kind: "ambiguous" }
  > {
    const variants = phoneVariants(phone);
    if (variants.length === 0) return { kind: "unknown" };

    const phoneRows = await prisma.customerPhone.findMany({
      where: {
        endedAt: null,
        phone: { in: variants },
      },
      select: {
        customer: {
          select: {
            id: true,
            shopId: true,
          },
        },
      },
      take: 11,
    });

    if (phoneRows.length >= 11) return { kind: "ambiguous" };

    let owners = deduplicateOwners(
      phoneRows.map(({ customer }) => ({
        shopId: customer.shopId,
        customerId: customer.id,
      })),
    );

    if (owners.length === 0) {
      const legacyRows = await prisma.customer.findMany({
        where: { phone: { in: variants } },
        select: { id: true, shopId: true },
        take: 11,
      });
      if (legacyRows.length >= 11) return { kind: "ambiguous" };
      owners = deduplicateOwners(
        legacyRows.map(({ id, shopId }) => ({ customerId: id, shopId })),
      );
    }

    if (owners.length === 0) return { kind: "unknown" };
    if (owners.length !== 1) return { kind: "ambiguous" };
    return { kind: "owner", owner: owners[0]! };
  }
}

function deduplicateOwners(owners: ConversationOwner[]): ConversationOwner[] {
  const unique = new Map<string, ConversationOwner>();
  for (const owner of owners) {
    unique.set(`${owner.shopId}:${owner.customerId}`, owner);
  }
  return [...unique.values()];
}

export const whatsappConversationRoutingService =
  new WhatsAppConversationRoutingService();
