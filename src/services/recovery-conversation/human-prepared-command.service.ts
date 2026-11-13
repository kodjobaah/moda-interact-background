import { readRecoveryLayoutReceipt,commonLayoutBody,humanCommonLayoutApplicationKey,currentCommonLayoutMatches,type RecoveryLayoutReceipt } from "../recovery-multipart/common-layout.js";
import { freezeBrandMedia, readFrozenBrandMedia, type FrozenBrandMediaEnvelope, type BrandPreparationReceipt } from "../conversation-delivery-plan.js";
import { currentRecoveryShopHeaderMatches } from "./recovery-shop-header-verification.js";
import { wrapperApplicationKey } from "../conversation-wrappers/application-key.js";
import { hasPreparedRecoveryShopHeader, withRecoveryShopHeader } from "../conversation-wrappers/recovery-shop-header.js";
import { createHash } from "node:crypto";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { first, rows, recoveryDatabase, type RecoveryDatabase, type SqlTransaction } from "./recovery-conversation.sql.js";
import { HumanWrapperPreparationService, type HumanWrapperCommand } from "./human-wrapper-preparation.service.js";
import { validRecoveryCheckoutFooterUrl, hasPreparedRecoveryCheckoutFooter, withHumanRecoveryCheckoutFooter } from "../conversation-wrappers/recovery-checkout-footer.js";
import { readPreparedWrapper } from "../conversation-wrappers/projection.js";

const logger = createLogger({
  serviceName: "moda-messaging-worker", environment: resolveDeploymentEnvironmentName(),
});
const digest = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

export type PreparedEvidence =
  | { schemaVersion: 1; outcome: "PASSTHROUGH"; reason: "NOT_CONFIGURED"; bodySha256: string; recoveryCheckoutUrl?: string; recoveryShopHeader?: RecoveryLayoutReceipt; mediaPreparation?: FrozenBrandMediaEnvelope }
  | { schemaVersion: 1; outcome: "RENDERED"; wrapperDefinitionId: string; localeId: string;
      audience: "HUMAN" | "SHARED"; slotEditVersion: number; applicationKey: string;
      contentHash: string; bodySha256: string; recoveryCheckoutUrl?: string; recoveryShopHeader?: RecoveryLayoutReceipt; mediaPreparation?: FrozenBrandMediaEnvelope };

export type FrozenHumanBody = { kind: "frozen"; body: string; evidence: PreparedEvidence }
  | { kind: "refused"; reason: string };

type FrozenRow = {
  kind: string; conversationId: string; textBody: string | null;
  preparedTextBody: string | null; preparedWrapperEvidence: unknown; preparedAt: Date | null;
  expectedControlRevision?: number; preparedInboundVersion?: number | null;
};

/** Never silently interpret an absent/partial prepared command as raw merchant text. */
export function parsePreparedEvidence(body: string | null, raw: unknown, at: Date | null): PreparedEvidence | null {
  if (!body?.trim() || !at || !Number.isFinite(at.getTime()) ||
      !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const evidence = raw as Record<string, unknown>;
  if (evidence.schemaVersion !== 1 || evidence.bodySha256 !== digest(body)) return null;
  if (evidence.recoveryCheckoutUrl !== undefined &&
      !validRecoveryCheckoutFooterUrl(evidence.recoveryCheckoutUrl)) return null;
  const header = evidence.recoveryShopHeader === undefined ? null : readRecoveryLayoutReceipt(evidence.recoveryShopHeader);
  if (evidence.recoveryShopHeader !== undefined && (!header || !(header.schemaVersion===2 ? commonLayoutBody(header)===body : hasPreparedRecoveryShopHeader(body, header)))) return null;
  if(evidence.recoveryCheckoutUrl!==undefined && !(header?.schemaVersion===2 ? header.variables['checkout.url']===evidence.recoveryCheckoutUrl : hasPreparedRecoveryCheckoutFooter(body,evidence.recoveryCheckoutUrl as string)))return null;
  let media: {mediaPreparation?: FrozenBrandMediaEnvelope} = {};
  if (evidence.mediaPreparation !== undefined) {
    const parsed = readFrozenBrandMedia(evidence.mediaPreparation);
    if (!parsed || !header || header.schemaVersion===2 || JSON.stringify(parsed.recoveryShopHeader) !== JSON.stringify(header) || parsed.plan.body !== body || parsed.receipt.sourceKind !== "HUMAN_COMMAND") return null;
    media = {mediaPreparation: parsed};
  }
  const footer = typeof evidence.recoveryCheckoutUrl === "string" ? { recoveryCheckoutUrl: evidence.recoveryCheckoutUrl } : {};
  if (header?.schemaVersion===2 && evidence.outcome!=="RENDERED")return null;
  if (evidence.outcome === "PASSTHROUGH" && evidence.reason === "NOT_CONFIGURED") {
    return { schemaVersion: 1, outcome: "PASSTHROUGH", reason: "NOT_CONFIGURED", bodySha256: digest(body), ...footer, ...media, ...(header ? {recoveryShopHeader: header} : {}) };
  }
  if (evidence.outcome !== "RENDERED" || typeof evidence.wrapperDefinitionId !== "string" ||
      !evidence.wrapperDefinitionId || typeof evidence.localeId !== "string" || !evidence.localeId ||
      !["HUMAN", "SHARED"].includes(String(evidence.audience)) ||
      typeof evidence.slotEditVersion !== "number" || !Number.isSafeInteger(evidence.slotEditVersion) ||
      evidence.slotEditVersion < 1 || typeof evidence.applicationKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(evidence.applicationKey) ||
      typeof evidence.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(evidence.contentHash)) return null;
  if(header?.schemaVersion===2 && (evidence.audience!=="SHARED" || evidence.wrapperDefinitionId!==header.commonRef.definitionId || evidence.localeId!==header.commonRef.localeId || evidence.contentHash!==header.commonRef.contentHash))return null;
  return {
    schemaVersion: 1, outcome: "RENDERED", wrapperDefinitionId: evidence.wrapperDefinitionId,
    localeId: evidence.localeId, audience: evidence.audience as "HUMAN" | "SHARED",
    slotEditVersion: evidence.slotEditVersion, applicationKey: evidence.applicationKey,
    contentHash: evidence.contentHash, bodySha256: digest(body), ...footer, ...media, ...(header ? {recoveryShopHeader: header} : {}),
  };
}

function preparedHumanPassthroughMatches(original: string | null, body: string | null, checkoutUrl?: string, header?: RecoveryLayoutReceipt): boolean {
  if (typeof original !== "string" || header?.schemaVersion===2) return false;
  const footerBody = checkoutUrl === undefined ? original : withHumanRecoveryCheckoutFooter(original, checkoutUrl);
  return body === (header ? withRecoveryShopHeader(footerBody, header) : footerBody);
}

/** This immutable CAS is the only writer of prepared human content. */
export class HumanPreparedCommandService {
  constructor(
    private readonly database: RecoveryDatabase = recoveryDatabase,
    private readonly preparer: Pick<HumanWrapperPreparationService, "prepare"> = new HumanWrapperPreparationService(),
  ) {}

  async freeze(command: HumanWrapperCommand & { shopId: string }, leaseToken: string): Promise<FrozenHumanBody> {
    if (command.kind !== "HUMAN_TEXT") return { kind: "refused", reason: "not_human_text" };
    const current = await this.read(command.id, leaseToken);
    if (!current || current.conversationId !== command.conversationId || current.textBody !== command.textBody ||
        current.kind !== "HUMAN_TEXT") return { kind: "refused", reason: "invalid_lease" };
    if (current.preparedTextBody !== null || current.preparedWrapperEvidence !== null || current.preparedAt !== null) {
      return this.fromRow(current, command.textBody, command.id, command.shopId);
    }
    const receipt: BrandPreparationReceipt | undefined = Number.isSafeInteger(current.expectedControlRevision) && Number.isSafeInteger(current.preparedInboundVersion)
      ? {sourceKind: "HUMAN_COMMAND", sourceId: command.id, shopId: command.shopId, conversationId: command.conversationId,
          inboundVersion: current.preparedInboundVersion!, controlRevision: current.expectedControlRevision!, firstPair: null} : undefined;
    const result = await this.preparer.prepare({...command, ...(receipt ? {mediaReceipt: receipt} : {})});
    if (result.kind === "refused") return { kind: "refused", reason: result.reason.toLowerCase() };
    if (result.kind === "not-applicable") return { kind: "refused", reason: "not_human_text" };
    if (result.kind === "prepared" && result.application.audience === "AI") {
      return { kind: "refused", reason: "prepared_invalid" };
    }
    const plan = result.kind === "passthrough" ? result.deliveryPlan : result.application.deliveryPlan;
    if (plan && (plan.kind !== "BRAND_IMAGE" || !receipt)) return {kind: "refused", reason: "prepared_invalid"};
    const policy = result.kind === "passthrough" ? result.brandMediaPolicy : result.application.brandMediaPolicy;
    if(plan?.kind === "BRAND_IMAGE" && !policy) return {kind:"refused",reason:"prepared_invalid"};
    const media = plan?.kind === "BRAND_IMAGE" && receipt ? {mediaPreparation: freezeBrandMedia(plan, receipt, (result.kind === "passthrough" ? result.recoveryShopHeader : result.application.recoveryShopHeader)!, policy!)} : {};
    const evidence: PreparedEvidence = result.kind === "passthrough"
      ? { schemaVersion: 1, outcome: "PASSTHROUGH", reason: "NOT_CONFIGURED", bodySha256: digest(result.body), ...media,
          ...(result.recoveryShopHeader ? {recoveryShopHeader: result.recoveryShopHeader} : {}),
          ...(result.recoveryCheckoutUrl ? {recoveryCheckoutUrl: result.recoveryCheckoutUrl} : {}) }
      : { schemaVersion: 1, outcome: "RENDERED", wrapperDefinitionId: result.application.wrapperDefinitionId,
          localeId: result.application.localeId,
          audience: result.application.audience as "HUMAN" | "SHARED",
          slotEditVersion: result.application.slotEditVersion, applicationKey: result.application.applicationKey,
          contentHash: result.application.contentHash, bodySha256: digest(result.body), ...media,
          ...(result.application.recoveryShopHeader ? {recoveryShopHeader: result.application.recoveryShopHeader} : {}),
          ...(result.application.recoveryCheckoutUrl ? {recoveryCheckoutUrl: result.application.recoveryCheckoutUrl} : {}) };
    if (!command.textBody || !result.body.includes(command.textBody) || !result.body.trim() || (result.kind === "passthrough" && !preparedHumanPassthroughMatches(command.textBody, result.body, evidence.recoveryCheckoutUrl, evidence.recoveryShopHeader)) ||
        !parsePreparedEvidence(result.body, evidence, new Date())) {
      return { kind: "refused", reason: "prepared_invalid" };
    }
    try {
      const updated = await rows<FrozenRow>(this.database, `
        UPDATE "whatsapp"."MerchantConversationSendCommand"
        SET "preparedTextBody"=$4, "preparedWrapperEvidence"=$5::jsonb,
            "preparedAt"=statement_timestamp(), "updatedAt"=statement_timestamp()
        WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='CLAIMED'
          AND "leaseExpiresAt">statement_timestamp() AND "providerDispatchKey" IS NULL
          AND "kind"='HUMAN_TEXT' AND "preparedTextBody" IS NULL
          AND "preparedWrapperEvidence" IS NULL AND "preparedAt" IS NULL
          AND "conversationId"=$3 AND "textBody"=$6
        RETURNING "kind"::text,"conversationId","textBody","preparedTextBody",
          "preparedWrapperEvidence","preparedAt"`,
        command.id, leaseToken, command.conversationId, result.body, JSON.stringify(evidence), command.textBody);
      if (updated.length) return this.fromRow(updated[0]!, command.textBody, command.id, command.shopId);
      const winner = await this.read(command.id, leaseToken);
      return winner ? this.fromRow(winner, command.textBody, command.id, command.shopId) : { kind: "refused", reason: "invalid_lease" };
    } catch (error) {
      logger.error("arch047.human_prepared.freeze_failed", {
        commandId: command.id, errorType: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
        error: error,
      });
      throw error;
    }
  }

  private fromRow(row: FrozenRow, original: string | null, commandId: string, shopId: string): FrozenHumanBody {
    const evidence = parsePreparedEvidence(row.preparedTextBody, row.preparedWrapperEvidence, row.preparedAt);
    if (!evidence || (evidence.mediaPreparation && (evidence.mediaPreparation.receipt.sourceId !== commandId || evidence.mediaPreparation.receipt.shopId !== shopId || evidence.mediaPreparation.receipt.conversationId !== row.conversationId)) || row.kind !== "HUMAN_TEXT" ||
        (evidence.outcome === "PASSTHROUGH" && !preparedHumanPassthroughMatches(original, row.preparedTextBody, evidence.recoveryCheckoutUrl, evidence.recoveryShopHeader))) {
      return { kind: "refused", reason: "prepared_invalid" };
    }
    if(evidence.recoveryShopHeader?.schemaVersion===2 && (evidence.outcome!=="RENDERED" || evidence.recoveryShopHeader.shopId!==shopId || evidence.recoveryShopHeader.boundaries.body!==original || typeof original!=="string" || evidence.applicationKey!==humanCommonLayoutApplicationKey({commandId,conversationId:row.conversationId,shopId,slotEditVersion:evidence.slotEditVersion,textBody:original,body:row.preparedTextBody!,receipt:evidence.recoveryShopHeader})))return {kind:"refused",reason:"prepared_invalid"};
    return { kind: "frozen", body: row.preparedTextBody!, evidence };
  }

  private read(commandId: string, leaseToken: string) {
    return first<FrozenRow>(this.database, `
      SELECT "kind"::text,"conversationId","textBody","preparedTextBody",
        "preparedWrapperEvidence","preparedAt","expectedControlRevision",
        (SELECT c."inboundVersion" FROM "whatsapp"."Conversation" c
          WHERE c."id"=cmd."conversationId" AND c."controlRevision"=cmd."expectedControlRevision" AND c."controlMode"='HUMAN') AS "preparedInboundVersion"
      FROM "whatsapp"."MerchantConversationSendCommand" cmd
      WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='CLAIMED'
        AND "leaseExpiresAt">statement_timestamp() AND "providerDispatchKey" IS NULL`, commandId, leaseToken);
  }
}

/** Runs INSIDE the existing final-admission transaction, after the command row is locked. */
export async function currentHumanWrapperMatches(
  tx: SqlTransaction, body: string | null, raw: unknown, at: Date | null,
  command?: { conversationId: string; commandId: string; textBody: string | null; shopId?: string },
): Promise<boolean> {
  const evidence = parsePreparedEvidence(body, raw, at);
  if (!evidence) return false;
  if(evidence.recoveryShopHeader?.schemaVersion===2){
    const common=evidence.recoveryShopHeader;
    return Boolean(command?.shopId && typeof command.textBody==="string" && common.boundaries.body===command.textBody && evidence.outcome==="RENDERED" && evidence.audience==="SHARED" && evidence.applicationKey===humanCommonLayoutApplicationKey({commandId:command.commandId,conversationId:command.conversationId,shopId:command.shopId,slotEditVersion:evidence.slotEditVersion,textBody:command.textBody,body:body!,receipt:common}) && await currentCommonLayoutMatches(tx,common,body!,{shopId:command.shopId,conversationId:command.conversationId,slotEditVersion:evidence.slotEditVersion}));
  }
  if (evidence.recoveryShopHeader && (!command?.shopId || !(await currentRecoveryShopHeaderMatches(tx, evidence.recoveryShopHeader, body, command.shopId)))) return false;
  // Share-lock the active slot and definition until the provider permit commits.
  const slots = await rows<{
    audience: string; definitionId: string; editVersion: number; kind: string;
    status: string; definitionAudience: string | null; publishedAt: Date | null;
    retiredAt: Date | null; sourceLanguageTag: string; astSchemaVersion: number;
    sourceHash: string; createdByAdminId: string;
  }>(tx, `
    SELECT slot."audience",slot."definitionId",slot."editVersion",
      def."kind"::text,def."status"::text,def."audience"::text AS "definitionAudience",
      def."publishedAt",def."retiredAt",def."sourceLanguageTag",def."astSchemaVersion",
      def."sourceHash",def."createdByAdminId"
    FROM "whatsapp"."WhatsAppConversationWrapperActiveSlot" slot
    JOIN "whatsapp"."WhatsAppTemplateDefinition" def ON def."id"=slot."definitionId"
    WHERE slot."audience" IN ('HUMAN','SHARED') FOR SHARE OF slot,def`);
  if (slots.length > 2 || slots.some((slot) => !["HUMAN", "SHARED"].includes(slot.audience))) return false;
  const active = slots.find((slot) => slot.audience === "HUMAN") ??
    slots.find((slot) => slot.audience === "SHARED");
  if (evidence.outcome === "PASSTHROUGH") {
    return !active && ((evidence.recoveryCheckoutUrl !== undefined || evidence.recoveryShopHeader !== undefined)
      ? Boolean(command && preparedHumanPassthroughMatches(command.textBody, body, evidence.recoveryCheckoutUrl, evidence.recoveryShopHeader))
      : !command || body === command.textBody);
  }
  if (!command?.textBody || !body?.includes(command.textBody) ||
      evidence.applicationKey !== wrapperApplicationKey({
        conversationId: command.conversationId, messageIdentity: command.commandId,
        source: "HUMAN", wrapperDefinitionId: evidence.wrapperDefinitionId,
        localeId: evidence.localeId, contentHash: evidence.contentHash,
        editVersion: evidence.slotEditVersion, responseDigest: digest(command.textBody),
        body: body!, recoveryCheckoutUrl: evidence.recoveryCheckoutUrl, recoveryShopHeader: evidence.recoveryShopHeader, deliveryPlan: evidence.mediaPreparation?.plan,
      })) return false;
  if (!active || active.audience !== evidence.audience ||
      active.definitionId !== evidence.wrapperDefinitionId ||
      active.editVersion !== evidence.slotEditVersion ||
      active.kind !== "MODA_CONVERSATION_WRAPPER" || active.definitionAudience !== active.audience ||
      active.status !== "PUBLISHED" || !active.publishedAt || active.retiredAt !== null ||
      active.sourceLanguageTag !== "en" || active.astSchemaVersion !== 1 ||
      !/^[a-f0-9]{64}$/.test(active.sourceHash) || !active.createdByAdminId) return false;
  const locale = await first<{ definitionId: string; status: string; contentHash: string | null;
    languageTag: string; providerLanguageCode: string | null; localeAst: unknown;
    reviewedAt: Date | null;
    reviewedByAdminId: string | null }>(tx, `
    SELECT "definitionId","status"::text,"contentHash","languageTag","providerLanguageCode",
      "localeAst","reviewedAt","reviewedByAdminId"
    FROM "whatsapp"."WhatsAppTemplateLocale"
    WHERE "id"=$1 FOR SHARE`, evidence.localeId);
  return Boolean(locale && locale.definitionId === active.definitionId &&
    locale.contentHash === evidence.contentHash &&
    readPreparedWrapper(locale.localeAst, locale.contentHash).kind === "ok" &&
    locale.providerLanguageCode === null &&
    (locale.languageTag === "en" ? locale.status === "SOURCE_SAVED" :
      locale.status === "REVIEWED" && !!locale.reviewedAt && !!locale.reviewedByAdminId));
}
