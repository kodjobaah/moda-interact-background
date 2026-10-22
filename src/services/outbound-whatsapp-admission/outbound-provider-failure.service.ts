import { MessageStatus, UsageMetric, type PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";
import { isDefinitiveWhatsAppError, isSynchronousRecipientFailure } from "../whatsapp-provider-rejection.js";
import { synchronousRecipientFailureService } from "../synchronous-recipient-failure.service.js";

/** Provider-outcome adapter. Compensation/reachability belongs to existing owners. */
export class OutboundProviderFailureService {
  constructor(
    private readonly database: Pick<PrismaClient, "conversationMessage" | "usageEvent"> = prisma,
    private readonly synchronousFailure: Pick<typeof synchronousRecipientFailureService, "afterAutomatedRejection"> =
      synchronousRecipientFailureService,
  ) {}

  async failPrepared(messageId: string): Promise<void> {
    await this.database.conversationMessage.update({
      where: { id: messageId }, data: { status: MessageStatus.FAILED },
    });
    await this.removeUsage(messageId);
  }

  async afterProviderError(messageId: string, recipient: string, error: unknown): Promise<void> {
    if (isSynchronousRecipientFailure(error)) {
      // Keep the exact usage row until compensation derives attempt/source lineage.
      await this.synchronousFailure.afterAutomatedRejection(messageId, recipient);
    } else if (isDefinitiveWhatsAppError(error)) {
      if (error.code === "provider-rejected" && error.providerCode) {
        await this.database.conversationMessage.update({
          where: { id: messageId },
          data: { status: MessageStatus.FAILED, failedAt: new Date(),
            providerFailureCode: error.providerCode },
        });
        await this.removeUsage(messageId);
      } else {
        await this.failPrepared(messageId);
      }
    }
    // No durable final disposition for timeout/unknown provider acceptance.
  }

  private async removeUsage(messageId: string): Promise<void> {
    await this.database.usageEvent.deleteMany({
      where: { sourceId: messageId, metric: UsageMetric.OUTBOUND_AUTOMATED_MESSAGE },
    });
  }
}
