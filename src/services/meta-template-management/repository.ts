import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";
import { fingerprint, MetaManagementError, type PreparedRegistration } from "./contracts.js";
import { MetaTemplateStatusRepository } from "./status-repository.js";

/** The schema owns technical uniqueness; BG003 owns lifecycle and CAS. */
export type MetaRegistrationDatabase = Pick<PrismaClient,
  "$transaction" | "whatsAppTemplateMetaRegistration" | "whatsAppTemplateMetaEvent">;
export type RegistrationWithLocale = NonNullable<Awaited<ReturnType<MetaTemplateRepository["load"]>>>;

export class MetaTemplateRepository extends MetaTemplateStatusRepository {
  constructor(db: MetaRegistrationDatabase = prisma, clock: () => Date = () => new Date()) { super(db, clock); }

  async load(id: string) {
    return this.db.whatsAppTemplateMetaRegistration.findUnique({
      where: { id }, include: { locale: { include: { definition: true } } },
    });
  }

  /** Bounded discovery; active shop templates refresh within 30 minutes even
   * when older producer releases scheduled a later retry. */
  async listDue(limit = 25): Promise<Array<{ id: string; submissionState: string }>> {
    const now = this.clock();
    return this.db.whatsAppTemplateMetaRegistration.findMany({
      where: {
        OR: [
          { submissionState: "READY_TO_SUBMIT", OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
          { submissionState: { in: ["SUBMITTING", "SUBMISSION_UNKNOWN", "SUBMITTED"] }, nextRetryAt: { lte: now } },
          { submissionState: "SUBMITTED", variants: { some: { enabled: true } },
            OR: [{ lastReconciledAt: null },
              { lastReconciledAt: { lte: new Date(now.getTime() - 30 * 60_000) } }],
            failureCode: null,
          },
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

  /** Preclaim-only deferral; never touches an in-flight/uncertain/submitted create. */
  async deferReadyRegistration(id: string, until: Date, error: MetaManagementError): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const row = await tx.whatsAppTemplateMetaRegistration.findUnique({ where: { id } });
      if (!row) return false;
      let count = 0;
      if (row.submissionState === "READY_TO_SUBMIT" && !row.lastSubmittedAt && !row.providerTemplateId &&
          (!row.nextRetryAt || row.nextRetryAt < until)) {
        count = (await tx.whatsAppTemplateMetaRegistration.updateMany({
          where: { id, submissionState: "READY_TO_SUBMIT", lastSubmittedAt: null, providerTemplateId: null, updatedAt: row.updatedAt },
          data: { nextRetryAt: until, failureCode: error.code, updatedAt: new Date(Math.max(this.clock().getTime(),row.updatedAt.getTime()+1)) },
        })).count;
      }
      if (!count && error.code !== "META_SAMPLE_APP_THROTTLED") return false;
      const evidence = { appId: String(error.diagnostics?.appId ?? ""), environment: String(error.diagnostics?.environment ?? ""),
        operation: error.diagnostics?.operation === "sample_upload" ? "sample_upload" : error.diagnostics?.operation === "sample_session" ? "sample_session" : "sample_operation",
        retryAt: until.toISOString(), ...(error.code === "META_SAMPLE_APP_THROTTLED" ? { providerErrorCode: 4 } : {}) };
      await tx.whatsAppTemplateMetaEvent.createMany({ skipDuplicates: true, data: [{
        eventIdentity: `bg075:app-defer:${fingerprint({ id, until: until.toISOString(), code: error.code })}`,
        registrationId: id, source: "BACKGROUND", eventType: error.code === "META_SAMPLE_APP_THROTTLED" ? "SAMPLE_APP_THROTTLED" : "SAMPLE_APP_DEFERRED",
        outcome: count ? "DEFERRED" : "STATE_UNCHANGED", failureCode: error.code, reasonCode: error.code, wabaId: row.wabaId,
        providerTemplateName: row.providerTemplateName, providerLanguageCode: row.providerLanguageCode,
        ...(error.code === "META_SAMPLE_APP_THROTTLED" ? { httpStatus: 403 } : {}), evidence, processedAt: this.clock(),
      }] });
      return count === 1;
    });
  }

  async deferReadyCohort(ids: readonly string[], wabaId: string, until: Date): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const rows = await tx.whatsAppTemplateMetaRegistration.findMany({
        where: { id: { in: [...ids].slice(0,50) }, wabaId, submissionState: "READY_TO_SUBMIT", lastSubmittedAt: null, providerTemplateId: null,
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lt: until } }] },
        orderBy: { id: "asc" }, select: { id: true, updatedAt: true },
      });
      for (const row of rows) await tx.whatsAppTemplateMetaRegistration.updateMany({
        where: { id: row.id, wabaId, submissionState: "READY_TO_SUBMIT", lastSubmittedAt: null, providerTemplateId: null, updatedAt: row.updatedAt },
        data: { nextRetryAt: until, updatedAt: new Date(Math.max(this.clock().getTime(),row.updatedAt.getTime()+1)) },
      });
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
      // A signed Meta status may arrive while the provider POST is in flight.
      // Its pending receipt must win over a later create acknowledgement.
      const pendingStatus = (await tx.whatsAppTemplateMetaEvent.count({
        where: { registrationId: claim.registrationId, source: "META_WEBHOOK", processedAt: null },
      })) > 0;
      const changed = await tx.whatsAppTemplateMetaRegistration.updateMany({
        where: { id: claim.registrationId, submissionState: "SUBMITTING", lastSubmittedAt: claim.submittedAt },
        data: {
          submissionState: state,
          ...(outcome.kind === "submitted" ? { providerTemplateId: outcome.providerId,
            providerStatus: pendingStatus ? "UNKNOWN" : "PENDING" } : {}),
          failureCode: pendingStatus ? "STATUS_RECONCILIATION_PENDING"
            : outcome.kind !== "submitted" ? outcome.code : null,
          // Unknown creates are polled/reconciled, NEVER blindly re-POSTed.
          nextRetryAt: pendingStatus ? this.clock()
            : outcome.kind === "unknown" ? new Date(this.clock().getTime() + 2 * 60_000)
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

  /** An unverifiable GET immediately fences approval; durable retry receipts
   * bound provider retry pressure across replicas, crashes and restarts. */
  async deferFailedReconciliation(registration: RegistrationWithLocale): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const now = this.clock();
      const recentFailures = await tx.whatsAppTemplateMetaEvent.count({
        where: { registrationId: registration.id, eventType: "RECONCILE_RETRY",
          receivedAt: { gte: new Date(now.getTime() - 30 * 60_000) } },
      });
      const nextRetryMs = Math.min(30 * 60_000, (2 ** Math.min(recentFailures, 5)) * 60_000);
      const updated = await tx.whatsAppTemplateMetaRegistration.updateMany({
        where: { id: registration.id, updatedAt: registration.updatedAt },
        data: { providerStatus: "UNKNOWN", failureCode: "PROVIDER_RECONCILIATION_FAILED",
          nextRetryAt: new Date(now.getTime() + nextRetryMs),
          updatedAt: new Date(Math.max(now.getTime(), registration.updatedAt.getTime() + 1)) },
      });
      // A newer webhook may have refenced this row. Do not overwrite its state.
      if (!updated.count) return;
      await tx.whatsAppTemplateMetaEvent.create({ data: {
        eventIdentity: `bg003:read-retry:${registration.id}:${randomUUID()}`,
        registrationId: registration.id, source: "BACKGROUND", eventType: "RECONCILE_RETRY",
        outcome: "UNCONFIRMED", failureCode: "PROVIDER_RECONCILIATION_FAILED",
        wabaId: registration.wabaId, providerTemplateId: registration.providerTemplateId,
        providerTemplateName: registration.providerTemplateName,
        providerLanguageCode: registration.providerLanguageCode,
        attemptNumber: recentFailures + 1, processedAt: now,
      } });
    });
  }

  async hasPendingObservation(registrationId: string): Promise<boolean> {
    return (await this.db.whatsAppTemplateMetaEvent.count({
      where: { registrationId, source: "META_WEBHOOK", processedAt: null },
    })) > 0;
  }

}
