import prisma from "../../lib/db.js";
import { MetaManagementError, type AuthenticatedTemplateObservation,
  type ProviderStatus } from "./contracts.js";
import type { MetaRegistrationDatabase, RegistrationWithLocale } from "./repository.js";
import { randomUUID } from "node:crypto";

/** Status receipts and provider projections share one Postgres transaction boundary. */
export class MetaTemplateStatusRepository {
  constructor(
    protected readonly db: MetaRegistrationDatabase = prisma,
    protected readonly clock: () => Date = () => new Date(),
  ) {}

  /** An authenticated observation fences the existing registration BEFORE Meta GET.
   * The receipt and status UNKNOWN change are atomic. A later network failure
   * cannot leave an APPROVED registration eligible to send. */
  async recordObservation(observation: AuthenticatedTemplateObservation): Promise<{
    duplicate: boolean; registrationId: string | null;
  }> {
    return this.db.$transaction(async (tx) => {
      const linked = await tx.whatsAppTemplateMetaRegistration.findUnique({
        where: { wabaId_providerTemplateName_providerLanguageCode: {
          wabaId: observation.wabaId, providerTemplateName: observation.providerTemplateName,
          providerLanguageCode: observation.providerLanguageCode,
        } },
        select: { id: true, providerTemplateId: true, updatedAt: true },
      });
      const existing = await tx.whatsAppTemplateMetaEvent.findUnique({
        where: { eventIdentity: observation.eventIdentity },
        select: { registrationId: true, wabaId: true, providerTemplateName: true,
          providerLanguageCode: true, providerTemplateId: true, providerStatus: true,
          reasonCode: true, evidence: true },
      });
      if (existing) {
        const evidence = existing.evidence as { occurredAt?: unknown } | null;
        if (existing.wabaId !== observation.wabaId ||
            existing.providerTemplateName !== observation.providerTemplateName ||
            existing.providerLanguageCode !== observation.providerLanguageCode ||
            existing.providerTemplateId !== (observation.providerTemplateId || null) ||
            existing.providerStatus !== observation.providerStatus ||
            existing.reasonCode !== (observation.reasonCode || null) ||
            evidence?.occurredAt !== observation.occurredAt) {
          throw new MetaManagementError("EVENT_IDENTITY_COLLISION", "blocked");
        }
        return { duplicate: true, registrationId: existing.registrationId };
      }
      const conflict = !!(linked?.providerTemplateId && observation.providerTemplateId &&
        linked.providerTemplateId !== observation.providerTemplateId);
      const now = this.clock();
      const received = await tx.whatsAppTemplateMetaEvent.createMany({ data: [{
        eventIdentity: observation.eventIdentity, registrationId: linked?.id ?? null,
        source: "META_WEBHOOK", eventType: "message_template_status_update",
        outcome: linked ? "RECONCILIATION_PENDING" : "UNMATCHED",
        wabaId: observation.wabaId, providerTemplateId: observation.providerTemplateId || null,
        providerTemplateName: observation.providerTemplateName,
        providerLanguageCode: observation.providerLanguageCode,
        providerStatus: observation.providerStatus,
        reasonCode: observation.reasonCode || null,
        failureCode: conflict ? "PROVIDER_ID_CONFLICT" : null,
        evidence: { occurredAt: observation.occurredAt },
        processedAt: linked ? null : now,
      }], skipDuplicates: true });
      // Concurrent insert: the second transaction has no authority to refence a
      // registration. It will retry the first pending reconciliation if linked.
      if (!received.count) {
        const other = await tx.whatsAppTemplateMetaEvent.findUniqueOrThrow({
          where: { eventIdentity: observation.eventIdentity },
        });
        if (other.wabaId !== observation.wabaId ||
            other.providerTemplateName !== observation.providerTemplateName ||
            other.providerLanguageCode !== observation.providerLanguageCode ||
            other.providerTemplateId !== (observation.providerTemplateId || null) ||
            other.providerStatus !== observation.providerStatus ||
            other.reasonCode !== (observation.reasonCode || null)) {
          throw new MetaManagementError("EVENT_IDENTITY_COLLISION", "blocked");
        }
        return { duplicate: true, registrationId: other.registrationId };
      }
      if (linked) {
        const updated = await tx.whatsAppTemplateMetaRegistration.updateMany({
          where: { id: linked.id, updatedAt: linked.updatedAt },
          data: { providerStatus: "UNKNOWN",
            failureCode: conflict ? "PROVIDER_ID_CONFLICT" : "STATUS_RECONCILIATION_PENDING",
            nextRetryAt: now,
            // Monotonic timestamp makes the CAS safe even within a single DB ms.
            updatedAt: new Date(Math.max(now.getTime(), linked.updatedAt.getTime() + 1)),
          },
        });
        if (updated.count !== 1) throw new MetaManagementError("STATUS_FENCE_RACE", "uncertain");
      }
      return { duplicate: false, registrationId: linked?.id ?? null };
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
      const now = this.clock();
      const active = await tx.whatsAppTemplateVariant.count({
        where: { metaRegistrationId: registration.id, enabled: true },
      });
      const changed = await tx.whatsAppTemplateMetaRegistration.updateMany({
        where: { id: registration.id, updatedAt: current.updatedAt },
        data: {
          ...(providerId ? { providerTemplateId: providerId } : {}),
          submissionState: nextState,
          providerStatus: outcome.kind === "found" && !unlinkedProvider ? outcome.status : "UNKNOWN",
          lastObservedCategory: outcome.kind === "found" ? outcome.category : null,
          lastObservedContentHash: outcome.kind === "found" ? outcome.observedHash : null,
          lastReconciledAt: now,
          nextRetryAt: outcome.kind === "absent" ? new Date(now.getTime() + boundedRetryMs)
            : new Date(now.getTime() + (active > 0 ? 30 : 6 * 60) * 60_000),
          driftDetectedAt: drift ? registration.driftDetectedAt ?? now : null,
          updatedAt: new Date(Math.max(now.getTime(), current.updatedAt.getTime() + 1)),
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
        processedAt: now,
      } });
      // Only mark receipts after a verified, complete provider snapshot has
      // committed. A concurrent newer observation cannot pass the above CAS.
      await tx.whatsAppTemplateMetaEvent.updateMany({
        where: { registrationId: registration.id, source: "META_WEBHOOK",
          outcome: "RECONCILIATION_PENDING", processedAt: null },
        data: { processedAt: now, outcome: "RECONCILED",
          ...(outcome.kind === "absent" ? { failureCode: "PROVIDER_NOT_FOUND" } : {}),
        },
      });
      return unlinkedProvider ? "drift" : true;
    });
  }
}
