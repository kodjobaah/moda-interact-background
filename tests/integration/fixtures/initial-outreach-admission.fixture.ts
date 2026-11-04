import { PrismaClient, type Prisma } from "@prisma/client";
import { vi } from "vitest";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { OutboundWhatsAppAdmissionService } from "../../../src/services/outbound-whatsapp-admission.service.js";
import { OutboundMessageDeliveryService } from "../../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { WooGuardedInitialSenderService } from "../../../src/services/woocommerce-recovery/woo-guarded-initial-sender.service.js";
import { WooInitialSendFenceService } from "../../../src/services/woocommerce-recovery/woo-initial-send-fence.service.js";
import { seedWooInitialPermit } from "./woo-initial-send-fence.fixture.js";

export const enabled = !!process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1";
export const connect = () => new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });

export function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

export function observeTransactions(
  client: PrismaClient, wrap: (tx: Prisma.TransactionClient) => Prisma.TransactionClient,
): PrismaClient {
  return new Proxy(client, {
    get(target, key) {
      if (key === "$transaction") return (
        callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
      ) => target.$transaction((tx) => callback(wrap(tx)), { ...options, timeout: 20_000 });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function seed(db: PrismaClient) {
  const { input } = await seedWooInitialPermit(db);
  const scope = { shopId: input.shopId, recoveryId: input.recoveryId, outreachAttemptId: input.attemptId };
  const requests = vi.fn().mockResolvedValue({ providerMessageId: `wamid-${input.messageId}` });
  const template = {
    name: input.templateName, languageCode: input.languageCode, canonicalLanguageTag: "en-GB",
    verifiedCategory: "MARKETING" as const,
    sendFields: { templateName: input.templateName, languageCode: input.languageCode,
      bodyParameters: ["fixture shop"], templateRegistration: input.templateRegistration },
  };
  const sendInput = {
    recovery: { id: input.recoveryId, shopId: input.shopId, checkoutToken: input.checkoutToken,
      customerId: input.customerId, completedAt: null, status: "DETECTED" as const,
      shop: { platform: "WOOCOMMERCE", status: "ACTIVE" } },
    consent: input.consent, recipient: input.recipient, template,
    attemptId: input.attemptId, conversationId: input.conversationId,
    idempotencyKey: input.idempotencyKey, recoveryCreditSourceKey: input.recoveryCreditSourceKey,
  };
  const service = (client: PrismaClient) => new OutboundWhatsAppAdmissionService(client);
  const sender = (client: PrismaClient) => new WooGuardedInitialSenderService(
    { read: async () => ({ kind: "none-observed" }) },
    createLogger({ serviceName: "initial-outreach-fixture", environment: "test", sink: () => {} }),
    service(client),
    new OutboundMessageDeliveryService(client, {
      sendWhatsAppTemplate: requests, getProviderAccountId: async () => input.templateRegistration.senderWabaId,
    } as never, { evaluate: async () => ({ allowed: true, shopId: input.shopId }) },
    undefined, undefined, {
      assessText: async () => ({ kind: "allow" }),
      requireCurrentAllowance: async () => true,
    } as never, undefined, undefined, undefined, new WooInitialSendFenceService(client)),
  );
  return { input, scope, requests, sendInput, service, sender };
}
