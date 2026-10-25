import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";
import { fingerprint, MetaManagementError, type AuthenticatedTemplateObservation,
  type PreparedRegistration, type ProviderStatus } from "./contracts.js";

/** The schema owns technical uniqueness; BG003 owns lifecycle and CAS. */
export type MetaRegistrationDatabase = Pick<PrismaClient,
  "$transaction" | "whatsAppTemplateMetaRegistration" | "whatsAppTemplateMetaEvent">;
export type RegistrationWithLocale = NonNullable<Awaited<ReturnType<MetaTemplateRepository["load"]>>>;

export class MetaTemplateRepository {
  constructor(private readonly db: MetaRegistrationDatabase = prisma, private readonly clock: () => Date = () => new Date()) {}

  async load(id: string) {
    return this.db.whatsAppTemplateMetaRegistration.findUnique({
      where: { id }, include: { locale: { include: { definition: true } } },
    });
  }

  /** Bounded, indexed discovery; the caller owns the worker scheduling cadence. */
  async listDue(limit = 25): Promise<Array<{ id: string; submissionState: string }>> {
    const now = this.clock();
    return this.db.whatsAppTemplateMetaRegistration.findMany({
      where: {
        OR: [
          { submissionState: "READY_TO_SUBMIT", OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
          { submissionState: { in: ["SUBMITTING", "SUBMISSION_UNKNOWN", "SUBMITTED"] }, nextRetryAt: { lte: now } },
        ],
      },
      orderBy: [{ nextRetryAt: "asc" }, { createdAt: "asc" }],
      take: Math.max(1, Math.min(limit, 50)),
      select: { id: true, submissionState: true },
    });
  }

  /** Fail closed for a malformed Admin-frozen payload without a Graph call. */
  async blockReadyRegistration(id: string, code: string): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const row = await tx.whatsAppTemplateMetaRegistration.findUnique({
        where: { id }, select: { submissionState: true, wabaId: true,
          providerTemplateName: true, providerLanguageCode: true },
      });
      if (row?.submissionState !== "READY_TO_SUBMIT") return false;
      const changed = await tx.whatsAppTemplateMetaRegistration.updateMany({
        where: { id, submissionState: "READY_TO_SUBMIT" },
        data: { submissionState: "BLOCKED", failureCode: code.slice(0, 128), nextRetryAt: null },
      });
      if (!changed.count) return false;
      await tx.whatsAppTemplateMetaEvent.create({ data: {
        eventIdentity: `bg003:blocked:${id}:${randomUUID()}`,
        registrationId: id, source: "BACKGROUND", eventType: "SUBMISSION_BLOCKED",
        outcome: "BLOCKED", failureCode: code.slice(0, 128), wabaId: row.wabaId,
        providerTemplateName: row.providerTemplateName, providerLanguageCode: row.providerLanguageCode,
        processedAt: this.clock(),
      } });
      return true;
    });
  }

  /** Creates the durable submission intent before any provider I/O. */
  async claim(id: string, wabaId: string): Promise<PreparedRegistration | null> {
    return this.db.$transaction(async (tx) => {
      const row = await tx.whatsAppTemplateMetaRegistration.findUnique({
        where: { id }, include: { locale: { include: { definition: true } } },
      });
      if (!row) throw new MetaManagementError("REGISTRATION_NOT_FOUND", "blocked");
      if (row.wabaId !== wabaId) throw new MetaManagementError("WABA_MISMATCH", "blocked");
      if (row.submissionState !== "READY_TO_SUBMIT" ||
          (row.nextRetryAt && row.nextRetryAt > this.clock())) return null;
      if (row.locale.definition.kind !== "META_RECOVERY" ||
          row.locale.definition.retiredAt || row.locale.definition.providerTemplateName !== row.providerTemplateName ||
          row.locale.providerLanguageCode !== row.providerLanguageCode ||
          row.locale.contentHash !== row.submittedContentHash ||
          row.locale.status !== "REVIEWED" ||
          row.locale.reviewedAt === null || !row.locale.reviewedByAdminId ||
          !/^[a-f0-9]{64}$/i.test(row.submittedContentHash) ||
          !["MARKETING", "UTILITY", "AUTHENTICATION"].includes(row.category)) {
        throw new MetaManagementError("FROZEN_SNAPSHOT_NOT_CONFIRMED", "blocked");
      }
      const claimedAt = this.clock();
      const claimed = await tx.whatsAppTemplateMetaRegistration.updateMany({
        where: { id, submissionState: "READY_TO_SUBMIT", updatedAt: row.updatedAt },
        data: { submissionState: "SUBMITTING", lastSubmittedAt: claimedAt,
          nextRetryAt: new Date(claimedAt.getTime() + 5 * 60_000), failureCode: null },
      });
      if (claimed.count !== 1) return null;
      const requestDigest = fingerprint({
        name: row.providerTemplateName, language: row.providerLanguageCode,
        category: row.category, components: row.componentsSnapshot,
      });
      await tx.whatsAppTemplateMetaEvent.create({ data: {
        eventIdentity: `bg003:intent:${id}:${randomUUID()}`,
        registrationId: id, source: "BACKGROUND", eventType: "CREATE_INTENT", outcome: "CLAIMED",
        wabaId, providerTemplateName: row.providerTemplateName,
        providerLanguageCode: row.providerLanguageCode, requestDigest,
        processedAt: claimedAt,
      } });
      return {
        registrationId: id, localeId: row.localeId, wabaId,
        name: row.providerTemplateName, language: row.providerLanguageCode,
        category: row.category as PreparedRegistration["category"],
        // Prisma JSON is immutable from this module's perspective.
        components: row.componentsSnapshot as PreparedRegistration["components"],
        contentHash: row.submittedContentHash, providerId: row.providerTemplateId,
        updatedAt: row.updatedAt, submittedAt: claimedAt,
        submissionState: "SUBMITTING",
      };
    });
  }

  /** This durable receipt is written only after a verified preflight GET found no
   * matching template. An intent without a post receipt must NOT adopt a later
   * provider record, because the failure could have preceded network dispatch. */
  async recordPostIntent(claim: PreparedRegistration): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const current = await tx.whatsAppTemplateMetaRegistration.findUnique({
        where: { id: claim.registrationId },
        select: { submissionState: true, lastSubmittedAt: true },
      });
      if (current?.submissionState !== "SUBMITTING" ||
          current.lastSubmittedAt?.getTime() !== claim.submittedAt?.getTime()) {
        throw new MetaManagementError("CREATE_CLAIM_STALE", "uncertain");
      }
      await tx.whatsAppTemplateMetaEvent.create({ data: {
        eventIdentity: `bg003:post-intent:${claim.registrationId}:${randomUUID()}`,
        registrationId: claim.registrationId, source: "BACKGROUND",
        eventType: "POST_INTENT", outcome: "DISPATCH_QUEUED", wabaId: claim.wabaId,
        providerTemplateName: claim.name, providerLanguageCode: claim.language,
        requestDigest: fingerprint({ name: claim.name, language: claim.language,
          category: claim.category, components: claim.components }),
        processedAt: this.clock(),
      } });
    });
  }

  async finishSubmission(claim: PreparedRegistration, outcome:
      { kind: "submitted"; providerId: string } |
      { kind: "failed" | "blocked" | "unknown"; code: string }): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const state = outcome.kind === "submitted" ? "SUBMITTED" :
        outcome.kind === "unknown" ? "SUBMISSION_UNKNOWN" :
        outcome.kind === "blocked" ? "BLOCKED" : "FAILED";
      const changed = await tx.whatsAppTemplateMetaRegistration.updateMany({
        where: { id: claim.registrationId, submissionState: "SUBMITTING", lastSubmittedAt: claim.submittedAt },
        data: {
          submissionState: state,
          ...(outcome.kind === "submitted" ? { providerTemplateId: outcome.providerId, providerStatus: "PENDING" } : {}),
          failureCode: outcome.kind !== "submitted" ? outcome.code : null,
          // Unknown creates are polled/reconciled, NEVER blindly re-POSTed.
          nextRetryAt: outcome.kind === "unknown" ? new Date(this.clock().getTime() + 2 * 60_000)
            : outcome.kind === "submitted" ? new Date(this.clock().getTime() + 6 * 60 * 60_000) : null,
        },
      });
      if (changed.count !== 1) return false;
      await tx.whatsAppTemplateMetaEvent.create({ data: {
        eventIdentity: `bg003:result:${claim.registrationId}:${randomUUID()}`,
        registrationId: claim.registrationId, source: "BACKGROUND",
        eventType: "CREATE_RESULT", outcome: state, wabaId: claim.wabaId,
        providerTemplateId: outcome.kind === "submitted" ? outcome.providerId : null,
        providerTemplateName: claim.name, providerLanguageCode: claim.language,
        requestDigest: fingerprint({ name: claim.name, language: claim.language,
          category: claim.category, components: claim.components }),
        failureCode: outcome.kind === "submitted" ? null : outcome.code,
        processedAt: this.clock(),
      } });
      return true;
    });
  }

  /** Durable append-only evidence, including unmatched external notifications. */
  async recordObservation(observation: AuthenticatedTemplateObservation): Promise<{
    duplicate: boolean; registrationId: string | null;
  }> {
    return this.db.$transaction(async (tx) => {
      const linked = await tx.whatsAppTemplateMetaRegistration.findUnique({
        where: { wabaId_providerTemplateName_providerLanguageCode: {
          wabaId: observation.wabaId, providerTemplateName: observation.providerTemplateName,
          providerLanguageCode: observation.providerLanguageCode,
        } },
        select: { id: true, providerTemplateId: true },
      });
      const registrationId = linked && (!linked.providerTemplateId || !observation.providerTemplateId ||
        linked.providerTemplateId === observation.providerTemplateId) ? linked.id : null;
      const event = await tx.whatsAppTemplateMetaEvent.createMany({ data: [{
        eventIdentity: observation.eventIdentity, registrationId, source: "META_WEBHOOK",
        eventType: "message_template_status_update", outcome: "OBSERVED",
        wabaId: observation.wabaId, providerTemplateId: observation.providerTemplateId || null,
        providerTemplateName: observation.providerTemplateName,
        providerLanguageCode: observation.providerLanguageCode,
        providerStatus: observation.providerStatus,
        reasonCode: observation.reasonCode?.slice(0, 128) || null,
        evidence: { occurredAt: observation.occurredAt },
        processedAt: this.clock(),
      }], skipDuplicates: true });
      if (event.count === 0) {
        const existing = await tx.whatsAppTemplateMetaEvent.findUnique({
          where: { eventIdentity: observation.eventIdentity },
          select: { registrationId: true, wabaId: true, providerTemplateName: true,
            providerLanguageCode: true, providerTemplateId: true },
        });
        if (!existing || existing.wabaId !== observation.wabaId ||
            existing.providerTemplateName !== observation.providerTemplateName ||
            existing.providerLanguageCode !== observation.providerLanguageCode ||
            existing.providerTemplateId !== (observation.providerTemplateId || null)) {
          throw new MetaManagementError("EVENT_IDENTITY_COLLISION", "blocked");
        }
        return { duplicate: true, registrationId: existing.registrationId };
      }
      return { duplicate: false, registrationId };
    });
  }

  /** Updates current projection and event atomically; a later competing update
   * prevents stale network reads overwriting a newer observation. */
  async recordReconciliation(
    registration: RegistrationWithLocale,
    outcome: { kind: "absent" } | { kind: "found"; providerId: string;
      status: ProviderStatus; category: string; observedHash: string; drift: boolean },
  ): Promise<boolean | "drift"> {
    return this.db.$transaction(async (tx) => {
      const current = await tx.whatsAppTemplateMetaRegistration.findUnique({
        where: { id: registration.id }, select: { updatedAt: true },
      });
      if (!current || current.updatedAt.getTime() !== registration.updatedAt.getTime()) return false;
      // A preflight failure can leave CREATE_INTENT without any provider POST.
      // Never adopt a same-name external template without POST_INTENT evidence.
      const postIntentCount = await tx.whatsAppTemplateMetaEvent.count({
        where: { registrationId: registration.id, eventType: "POST_INTENT" },
      });
      const canAdopt = postIntentCount > 0 &&
        ["SUBMITTING", "SUBMISSION_UNKNOWN", "SUBMITTED"].includes(registration.submissionState);
      const unlinkedProvider = outcome.kind === "found" && !canAdopt;
      const drift = outcome.kind === "found" && (
        outcome.drift || unlinkedProvider ||
        !!(registration.providerTemplateId && registration.providerTemplateId !== outcome.providerId));
      const providerId = outcome.kind === "found" && canAdopt && !drift && !registration.providerTemplateId
        ? outcome.providerId : registration.providerTemplateId;
      const nextState = outcome.kind === "found" && canAdopt && !drift ? "SUBMITTED" : registration.submissionState;
      const previousReconciliations = outcome.kind === "absent"
        ? await tx.whatsAppTemplateMetaEvent.count({ where: {
          registrationId: registration.id, eventType: "RECONCILE",
        } }) : 0;
      const boundedRetryMs = Math.min(30 * 60_000, (2 ** Math.min(previousReconciliations, 5)) * 60_000);
      const changed = await tx.whatsAppTemplateMetaRegistration.updateMany({
        where: { id: registration.id, updatedAt: current.updatedAt },
        data: {
          ...(providerId ? { providerTemplateId: providerId } : {}),
          submissionState: nextState,
          providerStatus: outcome.kind === "found" && !unlinkedProvider ? outcome.status : "UNKNOWN",
          lastObservedCategory: outcome.kind === "found" ? outcome.category : null,
          lastObservedContentHash: outcome.kind === "found" ? outcome.observedHash : null,
          lastReconciledAt: this.clock(),
          nextRetryAt: drift ? null : outcome.kind === "absent" ? new Date(this.clock().getTime() + boundedRetryMs)
            : new Date(this.clock().getTime() + 6 * 60 * 60_000),
          driftDetectedAt: drift ? registration.driftDetectedAt ?? this.clock() : null,
          failureCode: unlinkedProvider ? "UNLINKED_PROVIDER_ID" : drift ? "PROVIDER_DRIFT" : outcome.kind === "absent" ? "PROVIDER_NOT_FOUND" : null,
        },
      });
      if (changed.count !== 1) return false;
      await tx.whatsAppTemplateMetaEvent.create({ data: {
        eventIdentity: `bg003:reconcile:${registration.id}:${randomUUID()}`,
        registrationId: registration.id, source: "BACKGROUND", eventType: "RECONCILE",
        outcome: drift ? "DRIFT" : outcome.kind === "absent" ? "ABSENT" : "CURRENT",
        wabaId: registration.wabaId,
        providerTemplateId: outcome.kind === "found" ? outcome.providerId : registration.providerTemplateId,
        providerTemplateName: registration.providerTemplateName,
        providerLanguageCode: registration.providerLanguageCode,
        providerStatus: outcome.kind === "found" ? outcome.status : "UNKNOWN",
        failureCode: drift ? "PROVIDER_DRIFT" : null,
        requestDigest: registration.submittedContentHash,
        processedAt: this.clock(),
      } });
      return unlinkedProvider ? "drift" : true;
    });
  }
}
