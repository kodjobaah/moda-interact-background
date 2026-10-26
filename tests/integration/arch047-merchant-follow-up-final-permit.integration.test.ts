import "dotenv/config";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OutboundSendFenceService } from
  "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import type { FinalTemplateIdentity } from
  "../../src/services/recovery-template-integration/final-template-registration.service.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";

const integration = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

/** BG007's human path MUST take the same BG006 SQL registration fence before
 * provider dispatch admission, not a legacy category GET or a caller assertion.
 */
integration("ARCH-047 BG007 human final permit and revocation", () => {
  async function fixture(label: string) {
    const f = await humanDispatchFixture(label);
    const token = randomUUID().replaceAll("-", "").slice(0, 20);
    const templateName = `arch047_human_${token}`;
    const hash = "a".repeat(64);
    const providerTemplateId = BigInt(`0x${token}`).toString(10);
    // Match the actual transport fixture's configured sender account; a
    // registration for some other WABA cannot authorise a merchant send.
    const senderWabaId = f.provider.getProviderAccountId();
    const admin = await f.db.platformAdmin.create({ data: {
      email: `arch047-human-${token}@example.invalid`,
    } });
    const definition = await f.db.whatsAppTemplateDefinition.create({ data: {
      kind: "META_RECOVERY", purpose: "FOLLOW_UP", offerType: "NO_OFFER",
      providerTemplateName: templateName, category: "MARKETING", status: "PUBLISHED",
      sourceLanguageTag: "en", astSchemaVersion: 1, sourceHash: "b".repeat(64),
      publishedAt: new Date(Date.now() - 60_000), createdByAdminId: admin.id,
    } });
    const locale = await f.db.whatsAppTemplateLocale.create({ data: {
      definitionId: definition.id, languageTag: "en", providerLanguageCode: "en_US",
      status: "REVIEWED", contentHash: hash, reviewedAt: new Date(),
      reviewedByAdminId: admin.id,
    } });
    const registration = await f.db.whatsAppTemplateMetaRegistration.create({ data: {
      localeId: locale.id, wabaId: senderWabaId, providerTemplateName: templateName,
      providerLanguageCode: "en_US", category: "MARKETING", componentsSnapshot: [],
      parameterBindingsSnapshot: { header: [], body: [], buttons: [] },
      submittedContentHash: hash, providerTemplateId,
      submissionState: "SUBMITTED", providerStatus: "APPROVED",
      lastObservedContentHash: hash, lastObservedCategory: "MARKETING",
      lastReconciledAt: new Date(Date.now() - 60_000),
    } });
    const variant = await f.db.whatsAppTemplateVariant.create({ data: {
      shopId: f.shopId, providerAccountId: senderWabaId, purpose: "FOLLOW_UP_NO_OFFER",
      languageTag: "en", providerLanguageCode: "en_US", providerTemplateName: templateName,
      providerTemplateId, metaRegistrationId: registration.id,
      status: "APPROVED", enabled: true,
    } });
    const identity: FinalTemplateIdentity = {
      shopId: f.shopId, senderWabaId, purpose: "FOLLOW_UP_NO_OFFER",
      variantId: variant.id, registrationId: registration.id, definitionId: definition.id,
      providerTemplateId, providerTemplateName: templateName, providerLanguageCode: "en_US",
      submittedContentHash: hash, bindingFingerprint: hash,
    };
    async function cleanup() {
      await f.db.whatsAppTemplateVariant.delete({ where: { id: variant.id } });
      await f.db.whatsAppTemplateMetaRegistration.delete({ where: { id: registration.id } });
      await f.db.whatsAppTemplateLocale.delete({ where: { id: locale.id } });
      await f.db.whatsAppTemplateDefinition.delete({ where: { id: definition.id } });
      await f.db.platformAdmin.delete({ where: { id: admin.id } });
      await f.close();
    }
    return { f, identity, registrationId: registration.id, cleanup };
  }

  /** Run the real command, sequence-two claim, and BG006 SQL fence together.
   * BG001 preparation itself is tested separately; this adapter supplies its
   * completed immutable payload without allowing merchant-authored parameters.
   */
  function preparedFollowUp(identity: FinalTemplateIdentity) {
    return { kind: "prepared" as const,
      prepared: { purpose: "FOLLOW_UP_NO_OFFER" },
      send: {
        templateName: identity.providerTemplateName, languageCode: identity.providerLanguageCode,
        textHeader: "Hello from the store", bodyParameters: ["Trusted customer"],
        dynamicUrlButton: { index: 0, text: "https%3A%2F%2Fstore.example.test%2Fcheckout" },
        recoveryPromise: { kind: "NO_OFFER" as const },
        templateRegistration: identity,
      },
    };
  }

  it("sends the BG001-prepared merchant follow-up once through the BG006 final SQL fence", async () => {
    const seeded = await fixture("dispatcher-approved-template");
    try {
      const { f, identity } = seeded;
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand(identity.providerTemplateName);
      const [claim] = await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() });
      const resolved = preparedFollowUp(identity);
      const resolver = vi.fn(async () => resolved);
      const dispatcher = f.dispatcher(undefined, undefined, undefined, undefined, {
        fence: new OutboundSendFenceService(f.db, async () => null),
        followUpTemplates: { resolve: resolver } as never,
      });
      await dispatcher.processClaim(commandId, claim!.leaseToken);
      await dispatcher.processClaim(commandId, claim!.leaseToken); // replay cannot send again
      await dispatcher.close();
      await f.whatsapp.waitForMessageCount(1);

      expect(resolver).toHaveBeenCalledTimes(1);
      expect(f.providerHttpRequests).toEqual([{ type: "template" }]);
      expect(f.provider.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
      expect(f.provider.sendWhatsAppTemplate).toHaveBeenCalledWith(expect.objectContaining({
        templateName: identity.providerTemplateName, languageCode: "en_US",
        textHeader: "Hello from the store", bodyParameters: ["Trusted customer"],
        dynamicUrlButton: { index: 0, text: "https%3A%2F%2Fstore.example.test%2Fcheckout" },
        templateRegistration: identity,
      }));
      expect(await f.commandState(commandId)).toMatchObject({
        state: "SENT", providerDispatchKey: expect.any(String), dispatchAttemptCount: 1,
      });
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      })).outboundMessageId).toBeTruthy();
      expect(await f.db.recoveryOutreachAttempt.count({
        where: { checkoutRecoveryId: f.recoveryId, sequence: 2 },
      })).toBe(1);
      expect(f.billing.admitAndRevalidate).toHaveBeenCalledOnce();
      expect(f.billing.onConfirmedProviderSend).toHaveBeenCalledOnce();
    } finally { await seeded.cleanup(); }
  }, 60_000);

  it("cancels and releases the unconsumed merchant claim if Meta approval changes after preparation", async () => {
    const seeded = await fixture("dispatcher-revoked-template");
    try {
      const { f, identity, registrationId } = seeded;
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand(identity.providerTemplateName);
      const [claim] = await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() });
      const resolver = vi.fn(async () => {
        // Simulate the observation worker revoking status between BG001 and
        // the merchant command's short provider-permit transaction.
        await f.db.whatsAppTemplateMetaRegistration.update({
          where: { id: registrationId }, data: {
            providerStatus: "UNKNOWN", failureCode: "STATUS_RECONCILIATION_PENDING",
          },
        });
        return preparedFollowUp(identity);
      });
      const dispatcher = f.dispatcher(undefined, undefined, undefined, undefined, {
        fence: new OutboundSendFenceService(f.db, async () => null),
        followUpTemplates: { resolve: resolver } as never,
      });
      await dispatcher.processClaim(commandId, claim!.leaseToken);
      await dispatcher.close();

      expect(resolver).toHaveBeenCalledOnce();
      expect(await f.commandState(commandId)).toMatchObject({
        state: "CANCELLED", outboundMessageId: null, providerDispatchKey: null,
      });
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({
        where: { id: attemptId }, select: { initiatedBy: true, initiationKey: true, sentAt: true },
      })).toEqual({ initiatedBy: null, initiationKey: null, sentAt: null });
      expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect(f.providerHttpRequests).toEqual([]);
      expect(f.billing.onConfirmedProviderSend).not.toHaveBeenCalled();
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(0);
    } finally { await seeded.cleanup(); }
  }, 60_000);

  it("rejects missing BG001 identity without admitting a human provider permit", async () => {
    const seeded = await fixture("missing-template-identity");
    try {
      const { f, identity } = seeded;
      const { commandId } = await f.addMerchantFollowUpCommand(identity.providerTemplateName);
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const fence = new OutboundSendFenceService(f.db, async () => null);
      const base = { senderType: "HUMAN" as const,
        shopId: f.shopId, conversationId: f.conversationId, recoveryId: f.recoveryId,
        expectedControlRevision: 1, commandId, leaseToken: claim.leaseToken,
        recipient: f.recipient, now: new Date(),
      };
      expect(await fence.admitFinalSend({ ...base, proactive: {
        consent: null, verifiedCategory: "MARKETING", templateName: identity.providerTemplateName,
        languageCode: identity.providerLanguageCode,
      } })).toEqual({ kind: "suppressed", reason: "marketing-template-unverified" });
      expect(await f.commandState(commandId)).toMatchObject({ state: "CLAIMED", providerDispatchKey: null });
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await seeded.cleanup(); }
  }, 60_000);

  it("denies a durable PAUSED/UNKNOWN registration before human dispatch, credit, or sequence two", async () => {
    const seeded = await fixture("revoked-template-registration");
    try {
      const { f, identity, registrationId } = seeded;
      const { commandId, attemptId } = await f.addMerchantFollowUpCommand(identity.providerTemplateName);
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      await f.db.whatsAppTemplateMetaRegistration.update({
        where: { id: registrationId },
        data: { providerStatus: "UNKNOWN", failureCode: "STATUS_RECONCILIATION_PENDING" },
      });
      const result = await new OutboundSendFenceService(f.db, async () => null).admitFinalSend({
        senderType: "HUMAN", shopId: f.shopId, conversationId: f.conversationId,
        recoveryId: f.recoveryId, expectedControlRevision: 1,
        commandId, leaseToken: claim.leaseToken, recipient: f.recipient, now: new Date(),
        proactive: { consent: null, verifiedCategory: "MARKETING",
          templateName: identity.providerTemplateName,
          languageCode: identity.providerLanguageCode, templateRegistration: identity },
      });
      expect(result).toEqual({ kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" });
      expect(await f.commandState(commandId)).toMatchObject({
        state: "CLAIMED", providerDispatchKey: null, outboundMessageId: null,
      });
      expect(await f.db.conversationMessage.count({
        where: { conversationId: f.conversationId, senderType: "HUMAN" },
      })).toBe(0);
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      })).outboundMessageId).toBeNull();
      expect(f.providerHttpRequests).toHaveLength(0);
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(0);
    } finally { await seeded.cleanup(); }
  }, 60_000);
});
