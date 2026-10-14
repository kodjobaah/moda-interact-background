import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveLiveBudget, assertLiveBudgetFitsLease,
} from '../src/commerce/live-budget.ts';

const platform = (budget = { deadlineMs: 60000, outputTokens: 700 }) =>
  ({ id: 'default', scope: 'PLATFORM', shopId: null, merchantPricingPlanId: null,
    budgetSchemaVersion: 1, budget, editVersion: 3 });
const policy = (id, scope, owner, budget, editVersion = 1) => ({
  id, scope, shopId: scope === 'SHOP' ? owner : null,
  merchantPricingPlanId: scope === 'PRICE_PLAN' ? owner : null,
  budgetSchemaVersion: 1, budget, editVersion,
});
function fixture({ status = 'ACTIVE', handle = 'free', rows = [platform()], plan = 'plan-free' } = {}) {
  const calls = [];
  const db = {
    $transaction: async (fn, opts) => {
      assert.equal(opts.isolationLevel, 'RepeatableRead');
      return fn({
        subscription: { findUnique: async ({ where }) => {
          calls.push(['subscription', where.shopId]);
          return status === 'ABSENT' ? null : { status, planId: 'billing-id', plan: { shopifyPlanHandle: handle } };
        } },
        merchantPricingPlan: { findUnique: async ({ where }) => {
          calls.push(['plan', where.shopifyPlanHandle]);
          return plan ? { id: plan } : null;
        } },
        commerceModelPolicy: { findMany: async ({ where }) => {
          assert.equal(where.context, 'LIVE');
          assert.equal(where.environment, 'DEVELOPMENT');
          calls.push(['policies', where.OR]);
          return rows.filter(row => row.scope === 'PLATFORM' ||
            (row.scope === 'SHOP' && row.shopId === where.OR[1].shopId) ||
            (row.scope === 'PRICE_PLAN' && where.OR[2] && row.merchantPricingPlanId === where.OR[2].merchantPricingPlanId));
        } },
      });
    },
  };
  return { db, calls };
}
const identity = {
  environment: 'DEVELOPMENT', shopId: 'shop-A', conversationId: 'conv-A',
  recoveryId: 'recovery-A', inboundVersion: 7,
};
const lease = { processingStartedAt: new Date(Date.now() - 1000) };

await test('LIVE independent precedence: merchant output and plan deadline, current active plan', async () => {
  const f = fixture({ rows: [platform(), policy('price','PRICE_PLAN','plan-free',{deadlineMs:90000},4),
    policy('tenant','SHOP','shop-A',{outputTokens:1800},9),
    policy('another-shop','SHOP','shop-B',{deadlineMs:110000,outputTokens:50000})] });
  const result = await resolveLiveBudget({db:f.db,...identity});
  assert.equal(result.deadlineMs,90000);
  assert.equal(result.outputTokens,1800);
  assert.equal(result.deadlineSource,'PRICE_PLAN');
  assert.equal(result.outputTokenSource,'MERCHANT');
  assert.deepEqual(result.policyEditVersions,{platform:3,pricePlan:4,merchant:9});
  assert.equal(result.merchantPricingPlanId,'plan-free');
  assert.equal(f.calls.at(-1)[1].some(x => x.scope === 'PRICE_PLAN'),true);
});

await test('cancelled/pending plan and foreign Shop policy are never used', async () => {
  const f = fixture({status:'CANCELLED',rows:[platform(),policy('price','PRICE_PLAN','plan-free',{deadlineMs:100000}),
    policy('foreign','SHOP','shop-B',{outputTokens:3000})]});
  const result = await resolveLiveBudget({db:f.db,...identity});
  assert.equal(result.deadlineMs,60000);
  assert.equal(result.outputTokens,700);
  assert.equal(result.merchantPricingPlanId,null);
  assert.equal(f.calls.some(x=>x[0]==='plan'),false);
  assert.equal(f.calls.at(-1)[1].length,2);
});

await test('active plan without canonical pricing-plan match fails closed', async () => {
  const f=fixture({plan:null});
  await assert.rejects(resolveLiveBudget({db:f.db,...identity}), {reasonCode:'ACTIVE_PLAN_UNMATCHED'});
});

await test('invalid budget versions, explicit null, unknown keys, missing Platform fail closed', async () => {
  for (const [rows,reasonCode] of [
    [[{...platform(),budgetSchemaVersion:2}],'UNSUPPORTED_SCHEMA'],
    [[platform({deadlineMs:null,outputTokens:800})],'INVALID_BUDGET_VALUE'],
    [[platform({deadlineMs:60000,outputTokens:800,remoteCalls:10})],'UNKNOWN_BUDGET_FIELD'],
    [[policy('tenant','SHOP','shop-A',{outputTokens:800})],'PLATFORM_DEFAULT_MISSING'],
    [[platform(),policy('tenant','SHOP','shop-A',{deadlineMs:0})],'INVALID_BUDGET_VALUE'],
  ]) {
    const f=fixture({rows});
    await assert.rejects(resolveLiveBudget({db:f.db,...identity}),{reasonCode});
  }
});

await test('each invocation resolves current LIVE policy without Redis or cached budget', async () => {
  const rows=[platform(),policy('tenant','SHOP','shop-A',{outputTokens:1200})];
  const f=fixture({rows});
  const first=await resolveLiveBudget({db:f.db,...identity});
  assert.equal(first.outputTokens,1200);
  rows[1].budget.outputTokens=2000;
  // Same inbound identity can observe a new policy on a later invocation.
  const repeat=await resolveLiveBudget({db:f.db,...identity});
  assert.equal(repeat.outputTokens,2000);
  assert.equal(first.outputTokens,1200, 'already-resolved invocation keeps its local budget');
  assert.notDeepEqual(repeat,first);
});

await test('unsupported deadlines are rejected and can be fixed for the next invocation', async () => {
  const rows=[platform({deadlineMs:200000,outputTokens:800})];
  const f=fixture({rows});
  const first=await resolveLiveBudget({db:f.db,...identity});
  assert.throws(() => assertLiveBudgetFitsLease(first, lease.processingStartedAt),
    {reasonCode:'DEADLINE_EXCEEDS_PROCESSING_LEASE'});
  rows[0].budget.deadlineMs=60000;
  const next=await resolveLiveBudget({db:f.db,...identity});
  assert.doesNotThrow(() => assertLiveBudgetFitsLease(next, lease.processingStartedAt));
});

await test('unsupported lease deadlines are rejected, never silently clipped', () => {
  const budget={deadlineMs:90000};
  assert.doesNotThrow(()=>assertLiveBudgetFitsLease(budget,new Date(10000), 30000));
  assert.throws(()=>assertLiveBudgetFitsLease(budget,new Date(10000), 45000),
    {reasonCode:'DEADLINE_EXCEEDS_PROCESSING_LEASE'});
});
console.log('PASS ARCH-038 LIVE budget contract tests');
