import { recoveryDeliveryCompensationService } from "./recovery-delivery-compensation/reconcile.service.js";
import { recoveryDeliveryMerchantNotificationService } from "./recovery-delivery-merchant-notification.service.js";
import { recipientReachabilityFailureService } from "./recipient-reachability-failure.service.js";
import { synchronousRecipientFailureEvidenceService } from "./synchronous-recipient-failure-evidence.service.js";

/** Thin sync-to-async policy bridge. The durable FAILED message (not the
 * HTTP exception) is the sole source of compensation and suppression authority.
 */
export class SynchronousRecipientFailureService {
  constructor(
    private readonly evidence: Pick<typeof synchronousRecipientFailureEvidenceService, "record"> =
      synchronousRecipientFailureEvidenceService,
    private readonly correction: Pick<typeof recoveryDeliveryCompensationService, "reconcileMessage"> =
      recoveryDeliveryCompensationService,
    private readonly reachability: Pick<typeof recipientReachabilityFailureService, "afterCorrection"> =
      recipientReachabilityFailureService,
    private readonly notification: Pick<typeof recoveryDeliveryMerchantNotificationService, "notify"> =
      recoveryDeliveryMerchantNotificationService,
  ) {}

  async afterAutomatedRejection(messageId: string, recipient: string): Promise<void> {
    await this.evidence.record(messageId, recipient);
    await this.afterPersistedRejection(messageId);
  }

  /** HUMAN recovery-template path persists its command/message atomically first.
   * HUMAN_TEXT is deliberately never passed to this operation by the dispatcher.
   */
  async afterPersistedRejection(messageId: string): Promise<void> {
    const corrected = await this.correction.reconcileMessage(messageId);
    const reachability = await this.reachability.afterCorrection({ messageId }, corrected);
    await this.notification.notify({ messageId }, corrected, reachability);
  }
}

export const synchronousRecipientFailureService = new SynchronousRecipientFailureService();
