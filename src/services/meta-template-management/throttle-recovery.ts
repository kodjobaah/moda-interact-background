import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";
import { fingerprint, MetaManagementError } from "./contracts.js";
import { resolveMetaAppScope, type MetaAppScope } from "./app-operation.js";
import { assertReviewedPreclaimSource, assertUnclaimedPreclaimProjection, lockPreclaimRecoveryRow,
  parsePreclaimManifest, preclaimSnapshotDigest, readPreclaimRecoveryConfiguration,
  type PreclaimRecoveryManifest, type PreclaimRecoveryRow, type RecoveryConfiguration } from "./preclaim-recovery.js";

const rejected = "META_SAMPLE_SESSION_REJECTED";
export const THROTTLE_ATTESTATION = "I_ATTEST_EXTERNAL_403_CODE4_FOR_EXACT_MANIFEST_IDS";
export type ExternalThrottleEvidence = Readonly<{ sha256: string; reference: string;
  attestation: typeof THROTTLE_ATTESTATION; operation: "sample_session" | "sample_upload";
  httpStatus: 403; providerErrorCode: 4; registrationIds: readonly string[] }>;
export type ThrottleRecoveryManifest = Readonly<{ version: 1; kind: "sample-app-code4";
  environment: MetaAppScope["environment"]; preclaim: PreclaimRecoveryManifest; externalEvidence: ExternalThrottleEvidence }>;
function refuse(code: string): never { throw new MetaManagementError(code, "blocked"); }
function parseManifest(raw: unknown): ThrottleRecoveryManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("RECOVERY_MANIFEST_INVALID");
  const m = raw as Record<string, unknown>;
  if (Object.keys(m).sort().join() !== "environment,externalEvidence,kind,preclaim,version" || m.version !== 1 || m.kind !== "sample-app-code4") refuse("RECOVERY_MANIFEST_INVALID");
  const preclaim = parsePreclaimManifest(m.preclaim);
  if (typeof m.environment !== "string" || resolveMetaAppScope(preclaim.appId, m.environment).environment !== m.environment) refuse("RECOVERY_ENVIRONMENT_INVALID");
  validateEvidence(m.externalEvidence, preclaim.entries.map((entry) => entry.id));
  return raw as ThrottleRecoveryManifest;
}
function validateEvidence(raw: unknown, ids: readonly string[]): asserts raw is ExternalThrottleEvidence {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("RECOVERY_EXTERNAL_EVIDENCE_REQUIRED");
  const e = raw as Record<string, unknown>;
  if (Object.keys(e).sort().join() !== "attestation,httpStatus,operation,providerErrorCode,reference,registrationIds,sha256" ||
      typeof e.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256) || typeof e.reference !== "string" || !/^[A-Za-z0-9@._:-]{1,128}$/.test(e.reference) ||
      e.attestation !== THROTTLE_ATTESTATION || e.httpStatus !== 403 || e.providerErrorCode !== 4 ||
      !["sample_session", "sample_upload"].includes(String(e.operation)) || !Array.isArray(e.registrationIds) ||
      fingerprint([...e.registrationIds].sort()) !== fingerprint([...ids].sort())) refuse("RECOVERY_EXTERNAL_EVIDENCE_REQUIRED");
}
async function eligible(tx: Prisma.TransactionClient, row: PreclaimRecoveryRow, scope: MetaAppScope, wabaId: string, evidence: ExternalThrottleEvidence, replayIdentity?: string) {
  assertUnclaimedPreclaimProjection(row); assertReviewedPreclaimSource(row);
  if (row.wabaId !== wabaId) refuse("RECOVERY_WABA_MISMATCH");
  const expected = evidence.operation === "sample_session" ? rejected : "META_SAMPLE_UPLOAD_REJECTED";
  if (row.submissionState !== (replayIdentity ? "READY_TO_SUBMIT" : "BLOCKED") || row.failureCode !== (replayIdentity ? null : expected)) refuse("RECOVERY_NOT_PROVEN_PRECLAIM");
  const events = await tx.whatsAppTemplateMetaEvent.findMany({ where: { registrationId: row.id, ...(replayIdentity ? { eventIdentity: { not: replayIdentity } } : {}) } });
  let matchingBlock = false;
  for (const event of events) {
    if (event.wabaId !== wabaId || event.providerTemplateId !== null || event.providerRequestId !== null ||
        event.httpStatus !== null || event.attemptNumber !== null || event.providerStatus !== null || !event.processedAt ||
        event.providerTemplateName !== row.providerTemplateName || event.providerLanguageCode !== row.providerLanguageCode) refuse("RECOVERY_SUBMISSION_EVIDENCE");
    if (event.eventType === "SUBMISSION_BLOCKED" && event.source === "BACKGROUND" && event.outcome === "BLOCKED" &&
        ["META_APP_ID_MISSING_OR_INVALID", expected].includes(event.failureCode ?? "") &&
        event.requestDigest === null && event.reasonCode === null && event.evidence === null) {
      if (event.failureCode === expected) matchingBlock = true;
      continue;
    }
    // Only the accepted BG005 exact missing-app recovery receipt is compatible.
    if (event.eventType === "PRECLAIM_APP_RECOVERY" && event.source === "OPERATOR" && event.outcome === "READY_TO_SUBMIT" &&
        event.reasonCode === "PROVEN_PRECLAIM_APP_BLOCK" && event.failureCode === null && event.evidence && typeof event.evidence === "object" && !Array.isArray(event.evidence)) {
      const audit = event.evidence as Record<string, unknown>;
      const prior = parsePreclaimManifest(audit.manifest);
      if (event.requestDigest !== fingerprint(prior) || event.eventIdentity !== `bg075:preclaim:${fingerprint({ digest: event.requestDigest, id: row.id })}` ||
          prior.appId !== scope.appId || prior.wabaId !== wabaId || !prior.entries.some((entry) => entry.id === row.id) ||
          audit.snapshotDigest !== prior.entries.find((entry) => entry.id === row.id)?.snapshotDigest ||
          audit.previousState !== "BLOCKED" || audit.previousFailureCode !== "META_APP_ID_MISSING_OR_INVALID") refuse("RECOVERY_SUBMISSION_EVIDENCE");
      continue;
    }
    refuse("RECOVERY_SUBMISSION_EVIDENCE");
  }
  if (!matchingBlock) refuse("RECOVERY_EXTERNAL_EVIDENCE_REQUIRED");
}

/** Operator-only, attested external historical evidence. No generic rejection retry. */
export class MetaThrottlePreclaimRecovery {
  constructor(private readonly db: Pick<PrismaClient, "$transaction"> = prisma,
    private readonly configuration: () => Promise<RecoveryConfiguration> = readPreclaimRecoveryConfiguration,
    private readonly environment = () => resolveMetaAppScope("1").environment) {}
  async plan(ids: readonly string[], operator: string, proof: PreclaimRecoveryManifest["messagingWorkerProof"], externalEvidence: ExternalThrottleEvidence) {
    // Reuse strict ID/operator/proof validation before any database work.
    const config = await this.configuration();
    const base = parsePreclaimManifest({ version: 1, operator, ...config, messagingWorkerProof: proof,
      entries: ids.map((id) => ({ id, updatedAt: new Date(0).toISOString(), snapshotDigest: "0".repeat(64) })) });
    validateEvidence(externalEvidence, ids);
    const scope = { appId: config.appId, environment: this.environment() };
    return this.db.$transaction(async (tx) => {
      const entries = [];
      for (const id of [...ids].sort()) {
        const row = await lockPreclaimRecoveryRow(tx, id);
        await eligible(tx, row, scope, config.wabaId, externalEvidence);
        entries.push({ id, updatedAt: row.updatedAt.toISOString(), snapshotDigest: preclaimSnapshotDigest(row) });
      }
      const manifest = parseManifest({ version: 1, kind: "sample-app-code4", environment: scope.environment,
        preclaim: { ...base, entries }, externalEvidence });
      return { manifest, digest: fingerprint(manifest) };
    }, { isolationLevel: "Serializable", timeout: 30_000 });
  }
  async recover(raw: unknown, options: { apply?: boolean; digest?: string } = {}) {
    const manifest = parseManifest(raw); const digest = fingerprint(manifest);
    if (options.apply && options.digest !== digest) refuse("RECOVERY_DIGEST_MISMATCH");
    const config = await this.configuration();
    if (config.appId !== manifest.preclaim.appId || config.wabaId !== manifest.preclaim.wabaId || this.environment() !== manifest.environment) refuse("RECOVERY_CONFIGURATION_CHANGED");
    const scope = { appId: config.appId, environment: manifest.environment };
    return this.db.$transaction(async (tx) => {
      const rows = [];
      let applied = 0;
      for (const entry of [...manifest.preclaim.entries].sort((a,b) => a.id.localeCompare(b.id))) {
        const row = await lockPreclaimRecoveryRow(tx, entry.id);
        const identity = `bg075:throttle-recovery:${fingerprint({ digest, id: entry.id })}`;
        const audit = await tx.whatsAppTemplateMetaEvent.findUnique({ where: { eventIdentity: identity } });
        if (audit) {
          if (audit.registrationId !== row.id || audit.requestDigest !== digest || audit.source !== "OPERATOR" || audit.eventType !== "PRECLAIM_THROTTLE_RECOVERY") refuse("RECOVERY_AUDIT_MISMATCH");
          const saved = audit.evidence && typeof audit.evidence === "object" && !Array.isArray(audit.evidence) ? audit.evidence as Record<string, unknown> : null;
          if (!saved || fingerprint(saved.manifest) !== digest || saved.provenance !== "OPERATOR_ATTESTED_EXTERNAL_EVIDENCE_NOT_LEGACY_DB_PROOF" ||
              audit.wabaId !== config.wabaId || audit.outcome !== "READY_TO_SUBMIT" || audit.reasonCode !== "EXTERNAL_EVIDENCE_ATTESTED") refuse("RECOVERY_AUDIT_MISMATCH");
          await eligible(tx,row,scope,config.wabaId,manifest.externalEvidence,identity);
          if (preclaimSnapshotDigest(row) !== entry.snapshotDigest || row.nextRetryAt?.toISOString() !== saved.cooldownUntil) refuse("RECOVERY_REPLAY_STATE_CHANGED");
          applied++;
        } else {
          await eligible(tx, row, scope, config.wabaId, manifest.externalEvidence);
          if (row.updatedAt.toISOString() !== entry.updatedAt || preclaimSnapshotDigest(row) !== entry.snapshotDigest) refuse("RECOVERY_SNAPSHOT_CHANGED");
        }
        rows.push({ entry, row, identity });
      }
      if (applied && applied !== rows.length) refuse("RECOVERY_BATCH_PARTIAL");
      if (applied) return { digest, mode: options.apply ? "apply" : "dry-run", outcome: "already-applied" };
      if (!options.apply) return { digest, mode: "dry-run", outcome: "eligible" };
      // Seed once per manifest, not per locale; never shorten existing cooldown or reset attempts.
      await tx.metaTemplateAppOperationState.upsert({ where: { environment_appId: scope }, create: scope, update: {} });
      await tx.$queryRaw`SELECT "appId" FROM whatsapp."MetaTemplateAppOperationState" WHERE environment=${scope.environment}::commerce."CommerceEnvironment" AND "appId"=${scope.appId} FOR UPDATE`;
      const state = await tx.metaTemplateAppOperationState.findUniqueOrThrow({ where: { environment_appId: scope } });
      const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
      if (state.leaseUntil && state.leaseUntil > now) refuse("RECOVERY_APP_LEASE_BUSY");
      const retainedSeconds = Math.min(21600,900*(2**Math.min(Math.max(state.consecutiveThrottleCount-1,0),5)));
      const until = state.cooldownUntil && state.cooldownUntil > now ? state.cooldownUntil : new Date(now.getTime()+retainedSeconds*1000);
      await tx.metaTemplateAppOperationState.update({ where: { environment_appId: scope }, data: {
        cooldownUntil: until, consecutiveThrottleCount: Math.max(state.consecutiveThrottleCount,1),
        lastThrottleAt: new Date(Math.max(state.lastThrottleAt?.getTime() ?? 0, now.getTime())),
      } });
      for (const { entry, row, identity } of rows) {
        const changed = await tx.whatsAppTemplateMetaRegistration.updateMany({ where: { id: row.id, wabaId: config.wabaId,
          submissionState: "BLOCKED", failureCode: row.failureCode, updatedAt: new Date(entry.updatedAt), providerTemplateId: null, lastSubmittedAt: null,
          submittedContentHash: row.submittedContentHash, componentsSnapshot: { equals: row.componentsSnapshot as Prisma.InputJsonValue },
          parameterBindingsSnapshot: { equals: row.parameterBindingsSnapshot as Prisma.InputJsonValue } },
          data: { submissionState: "READY_TO_SUBMIT", failureCode: null, nextRetryAt: until,
            updatedAt: new Date(Math.max(now.getTime(), row.updatedAt.getTime()+1)) } });
        if (changed.count !== 1) refuse("RECOVERY_CAS_LOST");
        await tx.whatsAppTemplateMetaEvent.create({ data: { eventIdentity: identity, registrationId: row.id,
          source: "OPERATOR", eventType: "PRECLAIM_THROTTLE_RECOVERY", outcome: "READY_TO_SUBMIT", wabaId: config.wabaId,
          providerTemplateName: row.providerTemplateName, providerLanguageCode: row.providerLanguageCode, requestDigest: digest,
          reasonCode: "EXTERNAL_EVIDENCE_ATTESTED", processedAt: now,
          evidence: { manifest: manifest as unknown as Prisma.InputJsonValue, cooldownUntil: until.toISOString(),
            provenance: "OPERATOR_ATTESTED_EXTERNAL_EVIDENCE_NOT_LEGACY_DB_PROOF" } } });
      }
      return { digest, mode: "apply", outcome: "recovered", cooldownUntil: until.toISOString() };
    }, { isolationLevel: "Serializable", timeout: 30_000 });
  }
}
