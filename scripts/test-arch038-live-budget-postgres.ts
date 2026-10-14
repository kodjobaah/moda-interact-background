/** Disposable PostgreSQL proof using the real ordered migrations and Prisma resolver. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { resolveLiveBudget, assertLiveBudgetFitsLease } from "../src/commerce/live-budget.js";

const container = `moda-arch038-bg001-${randomUUID()}`;
const dbName = "arch038_live_budget_fixture";
let running = false;
let client: PrismaClient | undefined;
function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, {
    input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function sql(statement: string): void {
  docker(["exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1",
    "-U", "postgres", "-d", dbName], statement);
}
async function run(): Promise<void> {
  docker(["run", "-d", "--name", container,
    "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=arch038-test",
    "-e", `POSTGRES_DB=${dbName}`, "pgvector/pgvector:pg17"]);
  running = true;
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try {
      docker(["exec", container, "pg_isready", "-q", "-h", "127.0.0.1",
        "-U", "postgres", "-d", dbName]);
      ready = true; break;
    } catch { await delay(1000); }
  }
  assert.ok(ready, "Postgres final TCP server did not start");
  const dirs = readdirSync(new URL("../database/prisma/migrations/", import.meta.url))
    .filter(name => /^\d{14}_.+/.test(name)).sort();
  assert.ok(dirs.some(name => name.includes("arch038_unified_model_policies")),
    "Advance the database submodule to accepted ARCH-038-DATABASE-001 before running this test");
  for (const name of dirs) {
    sql(readFileSync(new URL(`../database/prisma/migrations/${name}/migration.sql`, import.meta.url), "utf8"));
  }
  const port = docker(["port", container, "5432/tcp"])
    .split("\n").find(line => line.startsWith("127.0.0.1:"))?.split(":").at(-1);
  assert.ok(port && /^\d+$/.test(port), "Disposable Docker PostgreSQL TCP port was not published");
  client = new PrismaClient({ datasourceUrl:
    `postgresql://postgres:arch038-test@127.0.0.1:${port}/${dbName}?schema=public`,
  });
  await client.$connect();

  sql(`INSERT INTO "commerce"."Shop" ("id","domain","updatedAt")
    VALUES ('arch038-live-shop','arch038-live-shop.test',now()),
           ('arch038-foreign-shop','arch038-foreign-shop.test',now());
    INSERT INTO "public"."PlatformAdmin" ("id","email","updatedAt")
    VALUES ('arch038-test-admin','arch038-test-admin@example.test',now());
    BEGIN;
    INSERT INTO "billing"."BillingPlan" ("id","shopifyPlanHandle","name","kind","updatedAt")
    VALUES ('arch038-billing-plan','arch038-live-plan','ARCH038 LIVE','FREE',now());
    INSERT INTO "billing"."Subscription" ("id","shopId","planId","status","updatedAt")
    VALUES ('arch038-subscription','arch038-live-shop','arch038-billing-plan','ACTIVE',now());
    INSERT INTO "billing"."MerchantPricingPlan"
      ("id","shopifyPlanHandle","displayName","planKind","cataloguePosition",
       "includedRecoveryCredits","allowancePeriod","billingPeriod","recurringAmountMinor","currency","updatedAt")
    VALUES ('arch038-plan','arch038-live-plan','ARCH038 LIVE','FREE',
      (SELECT count(*) FROM "billing"."MerchantPricingPlan"),0,'LIFETIME','EVERY_30_DAYS',0,'GBP',now());
    INSERT INTO "billing"."MerchantPricingPlanTranslation"
      ("id","merchantPricingPlanId","locale","merchantDescription","updatedAt")
    SELECT 'arch038-translation-' || locale,'arch038-plan',locale,'Fixture',now()
    FROM unnest(ARRAY['cs','da','de','en','es','fi','fr','it','ja','ko','nb','nl','pl',
      'pt-BR','pt-PT','sv','th','tr','zh-Hans','zh-Hant']) locale;
    COMMIT;
    INSERT INTO "commerce"."CommerceModelPolicy"
      ("id","environment","context","scope","merchantPricingPlanId","budget","updatedByAdminId")
    VALUES ('arch038-live-plan-policy','DEVELOPMENT','LIVE','PRICE_PLAN','arch038-plan',
      '{"deadlineMs":90000}'::jsonb,'arch038-test-admin');
    INSERT INTO "commerce"."CommerceModelPolicy"
      ("id","environment","context","scope","shopId","budget","updatedByAdminId")
    VALUES ('arch038-live-shop-policy','DEVELOPMENT','LIVE','SHOP','arch038-live-shop',
      '{"outputTokens":1800}'::jsonb,'arch038-test-admin');`);
  const common = {
    db: client, environment: "DEVELOPMENT" as const, shopId: "arch038-live-shop",
    conversationId: "arch038-conv", recoveryId: "arch038-recovery", inboundVersion: 1,
  };
  const budget = await resolveLiveBudget(common);
  assert.equal(budget.deadlineMs, 90000);
  assert.equal(budget.outputTokens, 1800);
  assert.equal(budget.deadlineSource, "PRICE_PLAN");
  assert.equal(budget.outputTokenSource, "MERCHANT");
  const leaseStarted = new Date(Date.now() - 1_000);
  assert.doesNotThrow(() => assertLiveBudgetFitsLease(budget, leaseStarted));
  sql(`UPDATE "commerce"."CommerceModelPolicy" SET "budget"='{"outputTokens":2100}',
    "editVersion"=2,"updatedByAdminId"='arch038-test-admin' WHERE "id"='arch038-live-shop-policy';`);
  const later = await resolveLiveBudget(common);
  assert.equal(later.outputTokens, 2100,
    "a later invocation must read the updated LIVE policy, even with the same inbound identity");
  assert.equal(budget.outputTokens, 1800,
    "an in-flight invocation retains its locally resolved budget");
  assert.equal((await resolveLiveBudget({...common,shopId:"arch038-foreign-shop"})).outputTokens,800);
  console.log("PASS ARCH-038 LIVE budget disposable PostgreSQL");
}
try { await run(); }
finally {
  await client?.$disconnect();
  if (running) { docker(["rm", "-f", "-v", container]); console.log(`CLEANUP ${container}`); }
}
