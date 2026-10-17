import { MerchantSendCommandService } from "./merchant-send-command.service.js";
import { RecoveryFollowUpPolicyService } from "./recovery-follow-up-policy.service.js";
import { HumanSendPolicyService } from "./human-send-policy.service.js";

export type HumanEvaluation = { kind: "ready"; commandId: string; shopId: string; recipient: string; kindOfSend: "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE" }
  | { kind: "terminal"; reason: string }
  | { kind: "retryable"; reason: string };

/** BG002 calls this before durable final admission; the evaluator never sends.
 * It is intentionally platform-neutral and independent of worker registration.
 */
export class HumanCommandEvaluationService {
  constructor(
    private readonly commands: MerchantSendCommandService,
    private readonly followUp: RecoveryFollowUpPolicyService,
    private readonly policy: HumanSendPolicyService,
  ) {}

  async evaluateHumanCommand(commandId: string, leaseToken: string, now = new Date()): Promise<HumanEvaluation> {
    const claimed = await this.commands.loadClaimedCommand(commandId, leaseToken, now);
    if (claimed.kind !== "claimed") return { kind: "terminal", reason: claimed.reason };
    const command = claimed.command;
    const restriction = await this.policy.checkRestriction(command.shopId);
    if (restriction.kind === "denied") return { kind: "terminal", reason: restriction.reason };
    if (restriction.kind === "retryable") return restriction;
    const window = await this.followUp.checkServiceWindow(command.conversationId, now);
    if (window.kind !== "known") return { kind: "terminal", reason: "not-recovery-linked" };
    if (command.kind === "HUMAN_TEXT" && !window.open)
      return { kind: "terminal", reason: "customer-window-closed" };
    if (command.kind === "RECOVERY_FOLLOW_UP_TEMPLATE") {
      const followUp = await this.followUp.validateHumanFollowUp({
        conversationId: command.conversationId,
        expectedRevision: command.expectedControlRevision,
        now,
      });
      if (followUp.kind !== "allowed") return { kind: "terminal", reason: followUp.reason };
    }
    const screen = await this.policy.screenHumanCommand({
      commandId: command.id, shopId: command.shopId,
      recipient: command.recipientSnapshot, kind: command.kind,
      content: command.kind === "HUMAN_TEXT" ? command.textBody ?? "" : command.templateName ?? "",
      ...(command.kind === "RECOVERY_FOLLOW_UP_TEMPLATE" ? { templateName: command.templateName ?? "" } : {}),
    });
    if (screen.kind === "retryable") return screen;
    if (screen.kind === "denied") return { kind: "terminal", reason: screen.reason };
    return { kind: "ready", commandId, shopId: command.shopId,
      recipient: command.recipientSnapshot, kindOfSend: command.kind };
  }
}
