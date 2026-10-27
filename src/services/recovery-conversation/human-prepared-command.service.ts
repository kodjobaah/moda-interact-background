import { createHash } from "node:crypto";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { first, rows, recoveryDatabase, type RecoveryDatabase, type SqlTransaction } from "./recovery-conversation.sql.js";
import { HumanWrapperPreparationService, type HumanWrapperCommand } from "./human-wrapper-preparation.service.js";
import { readPreparedWrapper, stableJson } from "../conversation-wrappers/projection.js";

const logger = createLogger({
  serviceName: "moda-messaging-worker", environment: resolveDeploymentEnvironmentName(),
});
const digest = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

export type PreparedEvidence =
  | { schemaVersion: 1; outcome: "PASSTHROUGH"; reason: "NOT_CONFIGURED"; bodySha256: string }
  | { schemaVersion: 1; outcome: "RENDERED"; wrapperDefinitionId: string; localeId: string;
      audience: "HUMAN" | "SHARED"; slotEditVersion: number; applicationKey: string;
      contentHash: string; bodySha256: string };

export type FrozenHumanBody = { kind: "frozen"; body: string; evidence: PreparedEvidence }
  | { kind: "refused"; reason: string };

type FrozenRow = {
  kind: string; conversationId: string; textBody: string | null;
  preparedTextBody: string | null; preparedWrapperEvidence: unknown; preparedAt: Date | null;
};

/** Never silently interpret an absent/partial prepared command as raw merchant text. */
export function parsePreparedEvidence(body: string | null, raw: unknown, at: Date | null): PreparedEvidence | null {
  if (!body?.trim() || !at || !Number.isFinite(at.getTime()) ||
      !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const evidence = raw as Record<string, unknown>;
  if (evidence.schemaVersion !== 1 || evidence.bodySha256 !== digest(body)) return null;
  if (evidence.outcome === "PASSTHROUGH" && evidence.reason === "NOT_CONFIGURED") {
    return { schemaVersion: 1, outcome: "PASSTHROUGH", reason: "NOT_CONFIGURED", bodySha256: digest(body) };
  }
  if (evidence.outcome !== "RENDERED" || typeof evidence.wrapperDefinitionId !== "string" ||
      !evidence.wrapperDefinitionId || typeof evidence.localeId !== "string" || !evidence.localeId ||
      !["HUMAN", "SHARED"].includes(String(evidence.audience)) ||
      typeof evidence.slotEditVersion !== "number" || !Number.isSafeInteger(evidence.slotEditVersion) ||
      evidence.slotEditVersion < 1 || typeof evidence.applicationKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(evidence.applicationKey) ||
      typeof evidence.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(evidence.contentHash)) return null;
  return {
    schemaVersion: 1, outcome: "RENDERED", wrapperDefinitionId: evidence.wrapperDefinitionId,
    localeId: evidence.localeId, audience: evidence.audience as "HUMAN" | "SHARED",
    slotEditVersion: evidence.slotEditVersion, applicationKey: evidence.applicationKey,
    contentHash: evidence.contentHash, bodySha256: digest(body),
  };
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
      return this.fromRow(current, command.textBody);
    }
    const result = await this.preparer.prepare(command);
    if (result.kind === "refused") return { kind: "refused", reason: result.reason.toLowerCase() };
    if (result.kind === "not-applicable") return { kind: "refused", reason: "not_human_text" };
    if (result.kind === "prepared" && result.application.audience === "AI") {
      return { kind: "refused", reason: "prepared_invalid" };
    }
    const evidence: PreparedEvidence = result.kind === "passthrough"
      ? { schemaVersion: 1, outcome: "PASSTHROUGH", reason: "NOT_CONFIGURED", bodySha256: digest(result.body) }
      : { schemaVersion: 1, outcome: "RENDERED", wrapperDefinitionId: result.application.wrapperDefinitionId,
          localeId: result.application.localeId,
          audience: result.application.audience as "HUMAN" | "SHARED",
          slotEditVersion: result.application.slotEditVersion, applicationKey: result.application.applicationKey,
          contentHash: result.application.contentHash, bodySha256: digest(result.body) };
    if (!result.body.trim() || (result.kind === "passthrough" && result.body !== command.textBody) ||
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
      if (updated.length) return this.fromRow(updated[0]!, command.textBody);
      const winner = await this.read(command.id, leaseToken);
      return winner ? this.fromRow(winner, command.textBody) : { kind: "refused", reason: "invalid_lease" };
    } catch (error) {
      logger.error("arch047.human_prepared.freeze_failed", {
        commandId: command.id, errorType: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  }

  private fromRow(row: FrozenRow, original: string | null): FrozenHumanBody {
    const evidence = parsePreparedEvidence(row.preparedTextBody, row.preparedWrapperEvidence, row.preparedAt);
    if (!evidence || row.kind !== "HUMAN_TEXT" ||
        (evidence.outcome === "PASSTHROUGH" && row.preparedTextBody !== original)) {
      return { kind: "refused", reason: "prepared_invalid" };
    }
    return { kind: "frozen", body: row.preparedTextBody!, evidence };
  }

  private read(commandId: string, leaseToken: string) {
    return first<FrozenRow>(this.database, `
      SELECT "kind"::text,"conversationId","textBody","preparedTextBody",
        "preparedWrapperEvidence","preparedAt"
      FROM "whatsapp"."MerchantConversationSendCommand"
      WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='CLAIMED'
        AND "leaseExpiresAt">statement_timestamp() AND "providerDispatchKey" IS NULL`, commandId, leaseToken);
  }
}

/** Runs INSIDE the existing final-admission transaction, after the command row is locked. */
export async function currentHumanWrapperMatches(
  tx: SqlTransaction, body: string | null, raw: unknown, at: Date | null,
  command?: { conversationId: string; commandId: string; textBody: string | null },
): Promise<boolean> {
  const evidence = parsePreparedEvidence(body, raw, at);
  if (!evidence) return false;
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
    return !active && (!command || body === command.textBody);
  }
  if (!command?.textBody || !body?.includes(command.textBody) ||
      evidence.applicationKey !== digest(stableJson({
        conversationId: command.conversationId, messageIdentity: command.commandId,
        source: "HUMAN", wrapperDefinitionId: evidence.wrapperDefinitionId,
        localeId: evidence.localeId, contentHash: evidence.contentHash,
        editVersion: evidence.slotEditVersion, responseDigest: digest(command.textBody),
        bodyDigest: digest(body),
      }))) return false;
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
