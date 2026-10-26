import "dotenv/config";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
      localeId: locale.id, wabaId: "123456789", providerTemplateName: templateName,
      providerLanguageCode: "en_US", category: "MARKETING", componentsSnapshot: [],
      parameterBindingsSnapshot: { header: [], body: [], buttons: [] },
      submittedContentHash: hash, providerTemplateId,
      submissionState: "SUBMITTED", providerStatus: "APPROVED",
      lastObservedContentHash: hash, lastObservedCategory: "MARKETING",
      lastReconciledAt: new Date(Date.now() - 60_000),
    } });
    const variant = await f.db.whatsAppTemplateVariant.create({ data: {
      shopId: f.shopId, providerAccountId: "123456789", purpose: "FOLLOW_UP_NO_OFFER",
      languageTag: "en", providerLanguageCode: "en_US", providerTemplateName: templateName,
      providerTemplateId, metaRegistrationId: registration.id,
      status: "APPROVED", enabled: true,
    } });
    const identity: FinalTemplateIdentity = {
      shopId: f.shopId, senderWabaId: "123456789", purpose: "FOLLOW_UP_NO_OFFER",
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
