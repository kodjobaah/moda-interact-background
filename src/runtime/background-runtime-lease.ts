import { Prisma, type BackgroundRuntimeLeaseName, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import os from "node:os";

import prisma from "../lib/db.js";

export const LEASE_DURATION_MS = 120_000;
export const LEASE_HEARTBEAT_MS = 30_000;
export type BackgroundLeaseHandle = { name: BackgroundRuntimeLeaseName; ownerToken: string; generation: number };
type LeaseDatabase = Pick<PrismaClient, "$queryRaw">;
type LeaseRow = { name: BackgroundRuntimeLeaseName; generation: number };

export const processOwnerToken = `${os.hostname()}:${process.pid}:${randomUUID()}`;

export class BackgroundRuntimeLeaseService {
  constructor(private readonly database: LeaseDatabase = prisma, private readonly ownerToken = processOwnerToken) {}

  async tryAcquire(name: BackgroundRuntimeLeaseName): Promise<BackgroundLeaseHandle | null> {
    const rows = await this.database.$queryRaw<LeaseRow[]>(Prisma.sql`
      INSERT INTO "public"."BackgroundRuntimeLease"
        ("name", "ownerToken", "generation", "acquiredAt", "heartbeatAt", "leaseUntil", "updatedAt")
      VALUES (${name}::"BackgroundRuntimeLeaseName", ${this.ownerToken}, 1, NOW(), NOW(), NOW() + INTERVAL '120 seconds', NOW())
      ON CONFLICT ("name") DO UPDATE SET
        "ownerToken" = EXCLUDED."ownerToken",
        "generation" = "BackgroundRuntimeLease"."generation" + 1,
        "acquiredAt" = NOW(), "heartbeatAt" = NOW(),
        "leaseUntil" = NOW() + INTERVAL '120 seconds', "updatedAt" = NOW()
      WHERE "BackgroundRuntimeLease"."leaseUntil" <= NOW()
      RETURNING "name", "generation"
    `);
    const row = rows[0];
    return row ? { name: row.name, ownerToken: this.ownerToken, generation: row.generation } : null;
  }

  async heartbeat(handle: BackgroundLeaseHandle): Promise<boolean> {
    const rows = await this.database.$queryRaw<Array<{ name: BackgroundRuntimeLeaseName }>>(Prisma.sql`
      UPDATE "public"."BackgroundRuntimeLease"
      SET "heartbeatAt" = NOW(), "leaseUntil" = NOW() + INTERVAL '120 seconds', "updatedAt" = NOW()
      WHERE "name" = ${handle.name}::"BackgroundRuntimeLeaseName"
        AND "ownerToken" = ${handle.ownerToken}
        AND "generation" = ${handle.generation}
        AND "leaseUntil" > NOW()
      RETURNING "name"
    `);
    return rows.length === 1;
  }

  async release(handle: BackgroundLeaseHandle): Promise<boolean> {
    const rows = await this.database.$queryRaw<Array<{ name: BackgroundRuntimeLeaseName }>>(Prisma.sql`
      DELETE FROM "public"."BackgroundRuntimeLease"
      WHERE "name" = ${handle.name}::"BackgroundRuntimeLeaseName"
        AND "ownerToken" = ${handle.ownerToken}
        AND "generation" = ${handle.generation}
      RETURNING "name"
    `);
    return rows.length === 1;
  }

  async runWithLease<T>(name: BackgroundRuntimeLeaseName, work: (handle: BackgroundLeaseHandle) => Promise<T>): Promise<{ kind: "skipped" } | { kind: "completed"; value: T; leaseLost: boolean }> {
    const handle = await this.tryAcquire(name);
    if (!handle) return { kind: "skipped" };
    let leaseLost = false;
    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeatLoop = (): void => {
      if (closed || leaseLost) return;
      timer = setTimeout(() => {
        timer = undefined;
        heartbeatInFlight = this.heartbeat(handle).then((valid) => { if (!valid) leaseLost = true; }).finally(() => {
          heartbeatInFlight = undefined;
          heartbeatLoop();
        });
      }, LEASE_HEARTBEAT_MS);
      timer.unref();
    };
    heartbeatLoop();
    let value!: T;
    try {
      value = await work(handle);
    } finally {
      closed = true;
      if (timer) clearTimeout(timer);
      await heartbeatInFlight;
      if (!leaseLost) await this.release(handle);
    }
    return { kind: "completed", value, leaseLost };
  }
}

export const backgroundRuntimeLeaseService = new BackgroundRuntimeLeaseService();