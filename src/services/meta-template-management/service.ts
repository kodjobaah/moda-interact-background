import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { MetaManagementError, observedContentHash, parseProviderStatus,
  safeMetaError, validatedComponents, type AuthenticatedTemplateObservation,
  type ReconcileOutcome, type SubmissionOutcome } from "./contracts.js";
import { MetaGraphTemplateAdapter, type MetaTemplateProvider } from "./meta-graph.adapter.js";
import { MetaTemplateRepository } from "./repository.js";

const logger = createLogger({ serviceName: "moda-messaging-worker", environment: resolveDeploymentEnvironmentName() });

/** All provider calls run outside SQL transactions. Provider results never change
 * shop publication, assignment, consent, STOP or customer-delivery admission. */
export class MetaTemplateManagementService {
  constructor(
    private readonly repository: MetaTemplateRepository = new MetaTemplateRepository(),
    private readonly provider: MetaTemplateProvider = new MetaGraphTemplateAdapter(),
    private readonly reporting: Pick<StructuredLogger, "info" | "warn" | "error"> = logger,
  ) {}

  async submitPreparedRegistration(registrationId: string): Promise<SubmissionOutcome> {
    let claim: Awaited<ReturnType<MetaTemplateRepository["claim"]>> | null = null;
    try {
      const row = await this.repository.load(registrationId);
      if (!row) return { kind: "blocked", code: "REGISTRATION_NOT_FOUND" };
      await this.provider.verifyWaba(row.wabaId);
      if (row.providerTemplateId && row.submissionState === "SUBMITTED") {
        return { kind: "already-submitted", providerId: row.providerTemplateId };
      }
      if (row.submissionState !== "READY_TO_SUBMIT") {
        // An unknown or in-flight create must be reconciled, never blindly POSTed.
        if (["SUBMITTING", "SUBMISSION_UNKNOWN", "SUBMITTED"].includes(row.submissionState)) {
          const resolved = await this.reconcileRegistration(registrationId);
          const refreshed = await this.repository.load(registrationId);
          if (resolved.kind === "current" && refreshed?.providerTemplateId) {
            return { kind: "already-submitted", providerId: refreshed.providerTemplateId };
          }
          return { kind: "unknown", code: "RECONCILIATION_REQUIRED" };
        }
        return { kind: "busy", code: "NOT_READY_TO_SUBMIT" };
      }

      // Validate frozen provider transport + sample before any create. The Admin
      // digest relationship and confirmed reviewer are checked during SQL claim.
      validatedComponents(row.componentsSnapshot);
      if (!["MARKETING", "UTILITY", "AUTHENTICATION"].includes(row.category)) {
        throw new MetaManagementError("INVALID_CATEGORY", "blocked");
      }
      claim = await this.repository.claim(registrationId, row.wabaId);
      if (!claim) return { kind: "busy", code: "CONCURRENT_OR_NOT_DUE" };
      // Protect against a name already existing before our durable create intent.
      // A coincident provider record must never be adopted as Moda-authored.
      // The registered name must be unique and new, even on first POST.
      const existing = await this.provider.find(claim);
      if (existing.kind === "found") {
        const persisted = await this.repository.finishSubmission(claim, { kind: "blocked", code: "PROVIDER_NAME_COLLISION" });
        if (!persisted) throw new MetaManagementError("CREATE_CLAIM_STALE", "uncertain");
        this.reporting.warn("meta.template.create.blocked", { registrationId, code: "PROVIDER_NAME_COLLISION" });
        return { kind: "blocked", code: "PROVIDER_NAME_COLLISION" };
      }
      await this.repository.recordPostIntent(claim);
      const created = await this.provider.create(claim);
      const persisted = await this.repository.finishSubmission(claim, { kind: "submitted", providerId: created.id });
      if (!persisted) {
        throw new MetaManagementError("CREATE_ACK_CAS_LOST", "uncertain");
      }
      this.reporting.info("meta.template.create.submitted", { registrationId, providerTemplateId: created.id });
      return { kind: "submitted", providerId: created.id };
    } catch (error) {
      const details = safeMetaError(error);
      this.reporting.error("meta.template.create.error", { registrationId, ...details });
      if (!claim) {
        if (error instanceof MetaManagementError && error.disposition === "blocked") {
          if (["INVALID_COMPILED_COMPONENTS", "IMAGE_SAMPLE_HANDLE_REQUIRED", "INVALID_CATEGORY",
            "FROZEN_SNAPSHOT_NOT_CONFIRMED"].includes(error.code)) {
            let recordError: unknown;
            try { await this.repository.blockReadyRegistration(registrationId, error.code); }
            catch (persistenceError) {
              recordError = persistenceError;
              this.reporting.error("meta.template.create.block_failure", {
                registrationId, ...safeMetaError(persistenceError),
              });
            }
            if (recordError !== undefined) throw new AggregateError([error, recordError],
              "Meta submission block recording failed", { cause: error });
          }
          return { kind: "blocked", code: error.code };
        }
        throw error;
      }
      // Once intent exists, network failures (including GET/POST) are uncertain.
      // If the provider accepted the create and the response was lost, NEVER post
      // again from this state, even after another queue delivery.
      const outcome = error instanceof MetaManagementError && error.disposition === "blocked"
        ? { kind: "blocked" as const, code: error.code }
        : error instanceof MetaManagementError && error.disposition === "definitive"
        ? { kind: "failed" as const, code: error.code }
        : { kind: "unknown" as const, code: details.code };
      let compensationError: unknown;
      try {
        await this.repository.finishSubmission(claim, outcome);
      } catch (persistenceError) {
        compensationError = persistenceError;
        this.reporting.error("meta.template.create.compensation_failed", {
          registrationId, ...safeMetaError(persistenceError),
        });
      }
      if (compensationError !== undefined) {
        throw new AggregateError([error, compensationError], "Meta create and failure persistence failed", { cause: error });
      }
      if (outcome.kind === "blocked" || outcome.kind === "failed") return outcome;
      // Unexpected/uncertain faults should reach BullMQ's retry diagnostics. The
      // persisted UNKNOWN state fences accidental subsequent duplicate POSTs.
      throw error;
    }
  }

  async reconcileRegistration(registrationId: string): Promise<ReconcileOutcome> {
    try {
      const row = await this.repository.load(registrationId);
      if (!row) throw new MetaManagementError("REGISTRATION_NOT_FOUND", "blocked");
      await this.provider.verifyWaba(row.wabaId);
      if (!row.providerTemplateId && row.submissionState === "READY_TO_SUBMIT") {
        return { kind: "unconfirmed" };
      }
      const current = await this.provider.find({
        wabaId: row.wabaId, name: row.providerTemplateName,
        language: row.providerLanguageCode,
      });
      if (current.kind === "absent") {
        const updated = await this.repository.recordReconciliation(row, { kind: "absent" });
        this.reporting.warn("meta.template.reconcile.unconfirmed", { registrationId });
        return { kind: updated ? "unconfirmed" : "stale" };
      }
      const template = current.template;
      const observedHash = observedContentHash(template.components);
      const frozenHash = observedContentHash(validatedComponents(row.componentsSnapshot));
      const drift = template.category !== row.category || observedHash !== frozenHash ||
        (!!row.providerTemplateId && row.providerTemplateId !== template.id);
      const status = parseProviderStatus(template.status);
      const updated = await this.repository.recordReconciliation(row, {
        kind: "found", providerId: template.id, status,
        category: template.category, observedHash, drift,
      });
      if (drift) this.reporting.warn("meta.template.reconcile.drift", { registrationId, providerTemplateId: template.id });
      else this.reporting.info("meta.template.reconcile.current", { registrationId, status });
      return !updated ? { kind: "stale" } : { kind: drift || updated === "drift" ? "drift" : "current", status };
    } catch (error) {
      this.reporting.error("meta.template.reconcile.error", { registrationId, ...safeMetaError(error) });
      throw error;
    }
  }


  /** Existing orchestrators may call this bounded port on an approved cadence.
   * There is no new queue or self-starting scheduler in BG003. All unexpected
   * exceptions are logged and rethrown, never silently acknowledged. */
  async processDueRegistrations(limit = 25): Promise<{ inspected: number; processed: number }> {
    const due = await this.repository.listDue(limit);
    let processed = 0;
    const failures: unknown[] = [];
    for (const item of due) {
      try {
        if (item.submissionState === "READY_TO_SUBMIT") {
          await this.submitPreparedRegistration(item.id);
        } else {
          await this.reconcileRegistration(item.id);
        }
        processed += 1;
      } catch (error) {
        failures.push(error);
        this.reporting.error("meta.template.due.failed", { registrationId: item.id, ...safeMetaError(error) });
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Meta template due processing failed", { cause: failures[0] });
    }
    return { inspected: due.length, processed };
  }

  /** This port receives only an authenticated, validated observation from the
   * owning Messaging adapter. There is intentionally no guessed BullMQ decoder. */
  async processTemplateStatusObservation(input: AuthenticatedTemplateObservation): Promise<
    "duplicate" | "unmatched" | ReconcileOutcome["kind"]
  > {
    try {
      if (!input || !/^[A-Za-z0-9:_.-]{1,191}$/.test(input.eventIdentity) ||
          !/^\d{1,32}$/.test(input.wabaId) ||
          !/^[A-Za-z0-9_]{1,255}$/.test(input.providerTemplateName) ||
          !/^[A-Za-z_]{2,16}$/.test(input.providerLanguageCode) ||
          !Number.isFinite(Date.parse(input.occurredAt)) ||
          !/^[A-Za-z_]{1,32}$/.test(input.providerStatus)) {
        throw new MetaManagementError("INVALID_AUTHENTICATED_OBSERVATION", "blocked");
      }
      const receipt = await this.repository.recordObservation(input);
      // An already-inserted receipt can represent a crash/error between the
      // initial insert and the Meta GET. Retry projection on linked duplicates.
      if (receipt.duplicate && !receipt.registrationId) return "duplicate";
      if (!receipt.registrationId) {
        this.reporting.warn("meta.template.webhook.unmatched", { eventIdentity: input.eventIdentity });
        return "unmatched";
      }
      // Meta's current GET is authoritative: stale and reordered webhook status
      // labels never overwrite the current provider projection.
      const outcome = await this.reconcileRegistration(receipt.registrationId);
      this.reporting.info("meta.template.webhook.processed", {
        registrationId: receipt.registrationId, eventIdentity: input.eventIdentity, outcome: outcome.kind,
      });
      return outcome.kind;
    } catch (error) {
      this.reporting.error("meta.template.webhook.error", {
        eventIdentity: typeof input?.eventIdentity === "string" ? input.eventIdentity.slice(0, 191) : null,
        ...safeMetaError(error),
      });
      throw error;
    }
  }
}

export const metaTemplateManagementService = new MetaTemplateManagementService();
