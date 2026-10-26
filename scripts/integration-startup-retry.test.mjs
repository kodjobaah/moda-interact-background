import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isDisposablePostgresReadinessTimeout,
  runWithPostgresStartupRetry,
} from "./integration-startup-retry.mjs";

const timeout = () => new Error(
  "Unable to start ephemeral PostgreSQL (pgvector/pgvector:pg17): " +
  "PostgreSQL readiness timed out after 30000ms: docker exec failed",
);
function fixture() {
  const events = [];
  const logger = {
    warn: (event, data) => events.push({ level: "warn", event, data }),
    error: (event, data) => events.push({ level: "error", event, data }),
  };
  return { events, logger };
}

test("recognises only Shared's PostgreSQL startup readiness timeout", () => {
  assert.equal(isDisposablePostgresReadinessTimeout(timeout()), true);
  assert.equal(isDisposablePostgresReadinessTimeout(new Error("PostgreSQL readiness timed out after 30000ms")), false);
  assert.equal(isDisposablePostgresReadinessTimeout(new Error("Unable to start ephemeral PostgreSQL: migrations failed")), false);
});

test("returns an already-successful run without retrying", async () => {
  const { events, logger } = fixture();
  let count = 0;
  const result = await runWithPostgresStartupRetry(async () => {
    count += 1; return { code: 0 };
  }, logger, async () => assert.fail("no delay expected"));
  assert.deepEqual(result, { code: 0 });
  assert.equal(count, 1);
  assert.deepEqual(events, []);
});

test("returns nonzero Vitest status unchanged and never reruns failed tests", async () => {
  const { events, logger } = fixture();
  let count = 0;
  const result = await runWithPostgresStartupRetry(async () => {
    count += 1; return { code: 1, signal: null };
  }, logger, async () => assert.fail("no retry on failed tests"));
  assert.deepEqual(result, { code: 1, signal: null });
  assert.equal(count, 1);
  assert.deepEqual(events, []);
});

test("retries exactly once after startup timeout and logs safe metadata", async () => {
  const { events, logger } = fixture();
  let count = 0; let delayed = 0;
  const result = await runWithPostgresStartupRetry(async () => {
    count += 1;
    if (count === 1) throw timeout();
    return { code: 0 };
  }, logger, async () => { delayed += 1; });
  assert.deepEqual(result, { code: 0 });
  assert.equal(count, 2);
  assert.equal(delayed, 1);
  assert.deepEqual(events, [{
    level: "warn", event: "background.integration.postgres_startup.retry",
    data: { attempt: 1, maxAttempts: 2, errorKind: "postgres-readiness-timeout" },
  }]);
});

test("preserves both exceptions when both startup attempts time out", async () => {
  const { events, logger } = fixture();
  const failures = [timeout(), timeout()];
  let count = 0;
  await assert.rejects(
    runWithPostgresStartupRetry(async () => { throw failures[count++]; }, logger, async () => {}),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, failures);
      assert.equal(error.cause, failures[1]);
      return true;
    },
  );
  assert.equal(count, 2);
  assert.equal(events.length, 2);
  assert.equal(events[1].data.errorKind, "postgres-readiness-timeout");
  assert.ok(!JSON.stringify(events).includes("docker exec failed"));
});

test("never retries non-startup errors, including Redis and migration failures", async () => {
  const { events, logger } = fixture();
  const failure = new Error("Redis failed with a credential");
  let count = 0;
  await assert.rejects(
    runWithPostgresStartupRetry(async () => { count++; throw failure; }, logger, async () => {}),
    (error) => error === failure,
  );
  assert.equal(count, 1);
  assert.equal(events[0].data.errorKind, "unexpected");
  assert.ok(!JSON.stringify(events).includes("credential"));
});

test("a different failure on retry propagates unchanged and is logged", async () => {
  const { events, logger } = fixture();
  const migrationFailure = new Error("Prisma migration failed with private URL");
  let count = 0;
  await assert.rejects(
    runWithPostgresStartupRetry(async () => {
      count++;
      if (count === 1) throw timeout();
      throw migrationFailure;
    }, logger, async () => {}),
    (error) => error === migrationFailure,
  );
  assert.equal(count, 2);
  assert.equal(events.length, 2);
  assert.equal(events[1].data.errorKind, "unexpected");
  assert.ok(!JSON.stringify(events).includes("private URL"));
});
