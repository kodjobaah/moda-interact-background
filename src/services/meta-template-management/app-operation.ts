import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { CommerceEnvironmentSchema, type CommerceEnvironment } from "@modainteract/moda-interact-shared/commerce/model";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { MetaManagementError } from "./contracts.js";

export type MetaAppScope = Readonly<{ environment: CommerceEnvironment; appId: string }>;
export type MetaAppLease = MetaAppScope & Readonly<{ owner: string; generation: bigint }>;
export const SAMPLE_OPERATION_DEADLINE_MS = 90_000;
export const APP_LEASE_SECONDS = 120;
export const APP_INITIAL_COOLDOWN_SECONDS = 900;
export const APP_MAX_COOLDOWN_SECONDS = 21_600;
export function resolveMetaAppScope(appId: string, name = resolveDeploymentEnvironmentName()): MetaAppScope {
  const environment = CommerceEnvironmentSchema.safeParse(name.toUpperCase());
  if (!/^\d{1,32}$/.test(appId) || !environment.success) {
    throw new MetaManagementError("META_APP_CONFIGURATION_INVALID", "blocked");
  }
  return { appId, environment: environment.data };
}
function deferred(scope: MetaAppScope, until: Date, reason = "META_SAMPLE_OPERATION_DEFERRED") {
  return new MetaManagementError(reason, "uncertain", undefined, {
    appId: scope.appId, environment: scope.environment, retryAt: until.toISOString(),
  });
}

/** SQL is the correctness gate. No process-local/Redis fallback; no provider I/O here. */
export class MetaAppOperationRepository {
  constructor(private readonly db: Pick<PrismaClient, "$queryRaw" | "metaTemplateAppOperationState"> = prisma) {}

  async acquire(scope: MetaAppScope): Promise<MetaAppLease> {
    const owner = randomUUID();
    const rows = await this.db.$queryRaw<Array<{ leaseGeneration: bigint }>>`
      INSERT INTO whatsapp."MetaTemplateAppOperationState"
        (environment,"appId","leaseOwnerToken","leaseGeneration","leaseAcquiredAt","leaseUntil","updatedAt")
      VALUES (${scope.environment}::commerce."CommerceEnvironment",${scope.appId},${owner},1,clock_timestamp(),clock_timestamp()+interval '120 seconds',clock_timestamp())
      ON CONFLICT (environment,"appId") DO UPDATE SET
        "leaseOwnerToken"=EXCLUDED."leaseOwnerToken", "leaseGeneration"="MetaTemplateAppOperationState"."leaseGeneration"+1,
        "leaseAcquiredAt"=clock_timestamp(), "leaseUntil"=clock_timestamp()+interval '120 seconds',"updatedAt"=clock_timestamp()
      WHERE ("MetaTemplateAppOperationState"."cooldownUntil" IS NULL OR "MetaTemplateAppOperationState"."cooldownUntil"<=clock_timestamp())
        AND ("MetaTemplateAppOperationState"."leaseUntil" IS NULL OR "MetaTemplateAppOperationState"."leaseUntil"<=clock_timestamp())
      RETURNING "leaseGeneration"`;
    if (rows[0]) return { ...scope, owner, generation: rows[0].leaseGeneration };
    const row = await this.db.metaTemplateAppOperationState.findUniqueOrThrow({ where: { environment_appId: scope } });
    const until = new Date(Math.max(row.cooldownUntil?.getTime() ?? 0, row.leaseUntil?.getTime() ?? 0, Date.now()+1000));
    throw deferred(scope, until);
  }
  private async rejectLease(scope: MetaAppScope, code: string): Promise<never> {
    const current = await this.db.metaTemplateAppOperationState.findUniqueOrThrow({ where: { environment_appId: { environment: scope.environment, appId: scope.appId } } });
    throw deferred(scope, new Date(Math.max(current.cooldownUntil?.getTime() ?? 0, current.leaseUntil?.getTime() ?? 0, Date.now()+1000)), code);
  }
  async verify(lease: MetaAppLease): Promise<void> {
    const rows = await this.db.$queryRaw<Array<{ appId: string }>>`
      SELECT "appId" FROM whatsapp."MetaTemplateAppOperationState"
      WHERE environment=${lease.environment}::commerce."CommerceEnvironment" AND "appId"=${lease.appId}
        AND "leaseOwnerToken"=${lease.owner} AND "leaseGeneration"=${lease.generation}
        AND "leaseUntil">clock_timestamp() AND ("cooldownUntil" IS NULL OR "cooldownUntil"<=clock_timestamp())`;
    if (!rows.length) return this.rejectLease(lease, "META_SAMPLE_LEASE_LOST");
  }
  async finish(lease: MetaAppLease, success: boolean): Promise<void> {
    const rows = await this.db.$queryRaw<Array<{ appId: string }>>`
      UPDATE whatsapp."MetaTemplateAppOperationState" SET "leaseOwnerToken"=NULL,"leaseAcquiredAt"=NULL,"leaseUntil"=NULL,
        "consecutiveThrottleCount"=CASE WHEN ${success} THEN 0 ELSE "consecutiveThrottleCount" END,"updatedAt"=clock_timestamp()
      WHERE environment=${lease.environment}::commerce."CommerceEnvironment" AND "appId"=${lease.appId}
        AND "leaseOwnerToken"=${lease.owner} AND "leaseGeneration"=${lease.generation} AND "leaseUntil">clock_timestamp()
        AND ("cooldownUntil" IS NULL OR "cooldownUntil"<=clock_timestamp()) RETURNING "appId"`;
    if (!rows.length) return this.rejectLease(lease, "META_SAMPLE_LEASE_LOST");
  }
  async throttle(lease: MetaAppLease): Promise<Date> {
    const rows = await this.db.$queryRaw<Array<{ cooldownUntil: Date }>>`
      UPDATE whatsapp."MetaTemplateAppOperationState" SET
        "cooldownUntil"=GREATEST("cooldownUntil",clock_timestamp()+LEAST(21600,900*power(2,LEAST("consecutiveThrottleCount",5))) * interval '1 second'),
        "consecutiveThrottleCount"=LEAST(31,"consecutiveThrottleCount"+1),"lastThrottleAt"=clock_timestamp(),
        "leaseOwnerToken"=NULL,"leaseAcquiredAt"=NULL,"leaseUntil"=NULL,"updatedAt"=clock_timestamp()
      WHERE environment=${lease.environment}::commerce."CommerceEnvironment" AND "appId"=${lease.appId}
        AND "leaseOwnerToken"=${lease.owner} AND "leaseGeneration"=${lease.generation} AND "leaseUntil">clock_timestamp()
      RETURNING "cooldownUntil"`;
    if (!rows[0]) return this.rejectLease(lease, "META_SAMPLE_LEASE_LOST");
    return rows[0].cooldownUntil;
  }
}

/** One bounded upload (source + session + bytes), never an entire locale cohort. */
export class MetaAppSampleOperation {
  constructor(private readonly repository = new MetaAppOperationRepository(), private readonly deadlineMs = SAMPLE_OPERATION_DEADLINE_MS) {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > SAMPLE_OPERATION_DEADLINE_MS) throw new RangeError("Invalid sample deadline");
  }
  async run<T>(scope: MetaAppScope, work: (signal: AbortSignal, beforeHttp: () => Promise<void>) => Promise<T>): Promise<T> {
    const lease = await this.repository.acquire(scope);
    const signal = AbortSignal.timeout(this.deadlineMs);
    try {
      const result = await work(signal, async () => { signal.throwIfAborted(); await this.repository.verify(lease); signal.throwIfAborted(); });
      signal.throwIfAborted();
      await this.repository.finish(lease, true);
      return result;
    } catch (error) {
      if (error instanceof MetaManagementError && error.code === "META_SAMPLE_APP_THROTTLED") {
        const until = await this.repository.throttle(lease);
        throw new MetaManagementError(error.code, "uncertain", { cause: error }, {
          ...error.diagnostics, appId: scope.appId, environment: scope.environment, leaseGeneration: lease.generation.toString(), retryAt: until.toISOString(),
        });
      }
      await this.repository.finish(lease, false);
      throw error;
    }
  }
}
