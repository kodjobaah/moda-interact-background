import type { Prisma, PrismaClient } from "@prisma/client";
import { fingerprint, MetaManagementError, validatedComponents } from "./contracts.js";
import prisma from "../../lib/db.js";
import { platformConsumerConfiguration } from "../platform-configuration/consumers.js";

type Database = Pick<PrismaClient, "$transaction">;
type Transaction = Prisma.TransactionClient;
const include = { locale: { include: { definition: { include: { locales: { orderBy: { id: "asc" } } } } } } } as const;
type Row = Prisma.WhatsAppTemplateMetaRegistrationGetPayload<{ include: typeof include }>;
const failure = "META_APP_ID_MISSING_OR_INVALID";
const hash = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9_-]{1,191}$/;
function refuse(code: string): never { throw new MetaManagementError(code, "blocked"); }

export type PreclaimRecoveryManifest = Readonly<{
  version: 1; operator: string; wabaId: string; appId: string;
  messagingWorkerProof: Readonly<{ service: "moda-messaging-worker"; reference: string }>;
  entries: ReadonlyArray<Readonly<{ id: string; updatedAt: string; snapshotDigest: string }>>;
}>;
export type RecoveryConfiguration = { wabaId: string; appId: string };

/** Reads only trusted server configuration. Never verifies or uploads through Meta. */
export async function readPreclaimRecoveryConfiguration(): Promise<RecoveryConfiguration> {
  const sender = (await platformConsumerConfiguration.read("messaging.sender")).value;
  const appId = process.env.META_APP_ID?.trim() ?? "";
  if (!sender.accessToken || !sender.businessAccountId || !/^\d{1,32}$/.test(sender.businessAccountId) ||
      !/^\d{1,32}$/.test(appId)) refuse("RECOVERY_CONFIGURATION_INVALID");
  return { wabaId: sender.businessAccountId, appId };
}

/** Binds immutable registration transport AND the current source/reviewer identities.
 * No template body or secret is emitted in operator diagnostics. */
export function preclaimSnapshotDigest(row: Row): string {
  return fingerprint(JSON.parse(JSON.stringify({ localeId: row.localeId, wabaId: row.wabaId,
    providerTemplateName: row.providerTemplateName, providerLanguageCode: row.providerLanguageCode,
    category: row.category, components: row.componentsSnapshot, bindings: row.parameterBindingsSnapshot,
    contentHash: row.submittedContentHash, locale: row.locale,
  })));
}

function exactIds(ids: readonly string[]): void {
  if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length || ids.some((id) => !idPattern.test(id))) {
    refuse("RECOVERY_EXACT_IDS_REQUIRED");
  }
}
function operatorIdentity(operator: string): void {
  if (!/^[A-Za-z0-9@._:-]{1,128}$/.test(operator)) refuse("RECOVERY_OPERATOR_REQUIRED");
}
export function parsePreclaimManifest(input: unknown): PreclaimRecoveryManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) refuse("RECOVERY_MANIFEST_INVALID");
  const m = input as Record<string, unknown>;
  if (Object.keys(m).sort().join() !== "appId,entries,messagingWorkerProof,operator,version,wabaId" || m.version !== 1 ||
      typeof m.operator !== "string" || typeof m.wabaId !== "string" || typeof m.appId !== "string" ||
      !/^\d{1,32}$/.test(m.wabaId) || !/^\d{1,32}$/.test(m.appId) || !Array.isArray(m.entries)) refuse("RECOVERY_MANIFEST_INVALID");
  operatorIdentity(m.operator);
  const proof = m.messagingWorkerProof as Record<string, unknown> | undefined;
  if (!proof || Object.keys(proof).sort().join() !== "reference,service" || proof.service !== "moda-messaging-worker" ||
      typeof proof.reference !== "string" || !/^[A-Za-z0-9@._:-]{1,128}$/.test(proof.reference)) refuse("RECOVERY_MESSAGING_WORKER_PROOF_REQUIRED");
  for (const e of m.entries) {
    if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).sort().join() !== "id,snapshotDigest,updatedAt" ||
        typeof e.id !== "string" || typeof e.updatedAt !== "string" || typeof e.snapshotDigest !== "string" ||
        !hash.test(e.snapshotDigest) || !Number.isFinite(Date.parse(e.updatedAt)) ||
        new Date(e.updatedAt).toISOString() !== e.updatedAt) refuse("RECOVERY_MANIFEST_INVALID");
  }
  exactIds(m.entries.map((e) => e.id));
  return input as PreclaimRecoveryManifest;
}

export function parsePreclaimRecoveryArguments(args: readonly string[]):
  { mode: "plan"; ids: string[]; operator: string; proof: PreclaimRecoveryManifest["messagingWorkerProof"] } |
  { mode: "manifest"; path: string; apply: boolean; digest?: string } {
  const values = new Map<string, string | true>();
  const allowed = new Set(["--ids", "--operator", "--manifest", "--digest", "--apply", "--messaging-worker-proof"]);
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!allowed.has(key) || values.has(key)) refuse("RECOVERY_ARGUMENTS_INVALID");
    if (key === "--apply") values.set(key, true);
    else {
      const value = args[++i];
      if (!value || value.startsWith("--")) refuse("RECOVERY_ARGUMENTS_INVALID");
      values.set(key, value);
    }
  }
  if (values.has("--ids")) {
    if (values.has("--manifest") || values.has("--apply") || values.has("--digest") ||
        !values.has("--operator") || !values.has("--messaging-worker-proof")) refuse("RECOVERY_ARGUMENTS_INVALID");
    const ids = (values.get("--ids") as string).split(",");
    const operator = values.get("--operator") as string;
    exactIds(ids); operatorIdentity(operator);
    const reference = values.get("--messaging-worker-proof") as string;
    if (!/^[A-Za-z0-9@._:-]{1,128}$/.test(reference)) refuse("RECOVERY_MESSAGING_WORKER_PROOF_REQUIRED");
    return { mode: "plan", ids, operator, proof: { service: "moda-messaging-worker", reference } };
  }
  if (!values.has("--manifest") || values.has("--operator") || values.has("--messaging-worker-proof") ||
      (!values.has("--apply") && values.has("--digest")) || (values.has("--apply") && !hash.test(values.get("--digest") as string ?? ""))) refuse("RECOVERY_ARGUMENTS_INVALID");
  return { mode: "manifest", path: values.get("--manifest") as string, apply: values.has("--apply"),
    ...(values.has("--digest") ? { digest: values.get("--digest") as string } : {}) };
}

/** Explicit operator capability; never wired into workers, pollers or HTTP ingress.
 * A batch is all-or-nothing. Serialization/CAS errors refuse; no automatic retry. */
export class MetaPreclaimRecovery {
  constructor(private readonly db: Database = prisma,
    private readonly configuration = readPreclaimRecoveryConfiguration,
    private readonly clock = () => new Date()) {}

  private async lockedRow(tx: Transaction, id: string): Promise<Row> {
    await tx.$queryRaw`SELECT id FROM whatsapp."WhatsAppTemplateMetaRegistration" WHERE id = ${id} FOR UPDATE`;
    const row = await tx.whatsAppTemplateMetaRegistration.findUnique({ where: { id }, include });
    if (!row) refuse("RECOVERY_ROW_NOT_FOUND");
    // Lock all reviewed source rows and the definition against concurrent edits.
    await tx.$queryRaw`SELECT id FROM whatsapp."WhatsAppTemplateDefinition" WHERE id = ${row.locale.definitionId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM whatsapp."WhatsAppTemplateLocale" WHERE "definitionId" = ${row.locale.definitionId} ORDER BY id FOR SHARE`;
    return row;
  }

  private async eligible(tx: Transaction, row: Row, config: RecoveryConfiguration): Promise<void> {
    if (row.wabaId !== config.wabaId) refuse("RECOVERY_WABA_MISMATCH");
    if (row.submissionState !== "BLOCKED" || row.failureCode !== failure || row.providerTemplateId !== null ||
        row.lastSubmittedAt !== null || row.providerStatus !== null || row.lastReconciledAt !== null ||
        row.lastObservedContentHash !== null || row.lastObservedCategory !== null || row.driftDetectedAt !== null) refuse("RECOVERY_NOT_PROVEN_PRECLAIM");
    const events = await tx.whatsAppTemplateMetaEvent.findMany({ where: { registrationId: row.id } });
    // Positive historical evidence is required. Any unknown event is refused,
    // including CREATE_INTENT, POST_INTENT, results, webhooks and reconciliation.
    if (!events.length || events.some((e) => e.eventType !== "SUBMISSION_BLOCKED" || e.source !== "BACKGROUND" ||
        e.outcome !== "BLOCKED" || e.failureCode !== failure || e.wabaId !== row.wabaId ||
        e.providerTemplateName !== row.providerTemplateName || e.providerLanguageCode !== row.providerLanguageCode ||
        e.providerTemplateId !== null || e.providerRequestId !== null || e.httpStatus !== null ||
        e.attemptNumber !== null || e.requestDigest !== null || e.providerStatus !== null ||
        e.reasonCode !== null || e.evidence !== null || e.processedAt === null)) refuse("RECOVERY_SUBMISSION_EVIDENCE");
    const d = row.locale.definition;
    const source = d.locales.find((locale) => locale.languageTag === d.sourceLanguageTag);
    if (d.kind !== "META_RECOVERY" || d.retiredAt || d.providerTemplateName !== row.providerTemplateName ||
        d.category !== row.category || !hash.test(d.sourceHash) || !["MARKETING", "UTILITY", "AUTHENTICATION"].includes(row.category) ||
        row.locale.providerLanguageCode !== row.providerLanguageCode || row.locale.contentHash !== row.submittedContentHash ||
        !hash.test(row.submittedContentHash) || row.locale.status !== "REVIEWED" || !row.locale.reviewedAt ||
        !row.locale.reviewedByAdminId || !source || source.status !== "REVIEWED" || !source.reviewedAt ||
        !source.reviewedByAdminId || !source.contentHash || !hash.test(source.contentHash)) refuse("RECOVERY_SOURCE_NOT_REVIEWED");
    validatedComponents(row.componentsSnapshot);
    if (row.parameterBindingsSnapshot === null) refuse("RECOVERY_SOURCE_NOT_REVIEWED");
  }

  /** Default CLI mode: prepare a reviewable manifest, with no writes or events. */
  async plan(ids: readonly string[], operator: string, messagingWorkerProof: PreclaimRecoveryManifest["messagingWorkerProof"]): Promise<{ manifest: PreclaimRecoveryManifest; digest: string }> {
    exactIds(ids); operatorIdentity(operator);
    const config = await this.configuration();
    if (!/^\d{1,32}$/.test(config.appId) || !/^\d{1,32}$/.test(config.wabaId)) refuse("RECOVERY_CONFIGURATION_INVALID");
    return this.db.$transaction(async (tx) => {
      const entries = [];
      for (const id of [...ids].sort()) {
        const row = await this.lockedRow(tx, id);
        await this.eligible(tx, row, config);
        entries.push({ id, updatedAt: row.updatedAt.toISOString(), snapshotDigest: preclaimSnapshotDigest(row) });
      }
      const manifest = parsePreclaimManifest({ version: 1, operator, ...config, messagingWorkerProof, entries });
      return { manifest, digest: fingerprint(manifest) };
    }, { isolationLevel: "Serializable" });
  }

  /** A supplied manifest dry-runs unless apply and its exact digest are provided. */
  async recover(input: unknown, options: { apply?: boolean; digest?: string } = {}) {
    const manifest = parsePreclaimManifest(input);
    const digest = fingerprint(manifest);
    if (options.apply && options.digest !== digest) refuse("RECOVERY_DIGEST_MISMATCH");
    const config = await this.configuration();
    if (config.appId !== manifest.appId || config.wabaId !== manifest.wabaId) refuse("RECOVERY_CONFIGURATION_CHANGED");
    return this.db.$transaction(async (tx) => {
      const outcomes: Array<{ id: string; outcome: string }> = [];
      for (const entry of [...manifest.entries].sort((a, b) => a.id.localeCompare(b.id))) {
        const row = await this.lockedRow(tx, entry.id);
        const eventIdentity = `bg075:preclaim:${fingerprint({ digest, id: entry.id })}`;
        const previous = await tx.whatsAppTemplateMetaEvent.findUnique({ where: { eventIdentity } });
        if (previous) {
          if (previous.registrationId !== row.id || previous.eventType !== "PRECLAIM_APP_RECOVERY" ||
              previous.requestDigest !== digest || previous.source !== "OPERATOR" || previous.outcome !== "READY_TO_SUBMIT" ||
              previous.wabaId !== manifest.wabaId) refuse("RECOVERY_AUDIT_MISMATCH");
          if (row.submissionState !== "READY_TO_SUBMIT" || row.failureCode !== null || row.wabaId !== manifest.wabaId ||
              row.lastSubmittedAt !== null || row.providerTemplateId !== null ||
              preclaimSnapshotDigest(row) !== entry.snapshotDigest) refuse("RECOVERY_REPLAY_STATE_CHANGED");
          const unexpected = await tx.whatsAppTemplateMetaEvent.count({ where: { registrationId: row.id,
            eventType: { notIn: ["SUBMISSION_BLOCKED", "PRECLAIM_APP_RECOVERY"] } } });
          if (unexpected) refuse("RECOVERY_SUBMISSION_EVIDENCE");
          outcomes.push({ id: row.id, outcome: "already-applied" });
          continue;
        }
        await this.eligible(tx, row, config);
        if (row.updatedAt.toISOString() !== entry.updatedAt || preclaimSnapshotDigest(row) !== entry.snapshotDigest) refuse("RECOVERY_SNAPSHOT_CHANGED");
        if (options.apply) {
          const now = this.clock();
          const changed = await tx.whatsAppTemplateMetaRegistration.updateMany({
            where: { id: entry.id, wabaId: manifest.wabaId, submissionState: "BLOCKED", failureCode: failure,
              updatedAt: new Date(entry.updatedAt), providerTemplateId: null, lastSubmittedAt: null,
              submittedContentHash: row.submittedContentHash, componentsSnapshot: { equals: row.componentsSnapshot as Prisma.InputJsonValue },
              parameterBindingsSnapshot: { equals: row.parameterBindingsSnapshot as Prisma.InputJsonValue } },
            data: { submissionState: "READY_TO_SUBMIT", failureCode: null, nextRetryAt: now,
              updatedAt: new Date(Math.max(now.getTime(), row.updatedAt.getTime() + 1)) },
          });
          if (changed.count !== 1) refuse("RECOVERY_CAS_LOST");
          await tx.whatsAppTemplateMetaEvent.create({ data: {
            eventIdentity, registrationId: row.id, source: "OPERATOR", eventType: "PRECLAIM_APP_RECOVERY",
            outcome: "READY_TO_SUBMIT", wabaId: row.wabaId, providerTemplateName: row.providerTemplateName,
            providerLanguageCode: row.providerLanguageCode, requestDigest: digest, processedAt: now,
            reasonCode: "PROVEN_PRECLAIM_APP_BLOCK", evidence: { manifest: manifest as unknown as Prisma.InputJsonValue,
              previousState: "BLOCKED", previousFailureCode: failure, snapshotDigest: entry.snapshotDigest },
          } });
        }
        outcomes.push({ id: row.id, outcome: options.apply ? "recovered" : "eligible" });
      }
      return { digest, mode: options.apply ? "apply" : "dry-run", outcomes };
    }, { isolationLevel: "Serializable" });
  }
}
