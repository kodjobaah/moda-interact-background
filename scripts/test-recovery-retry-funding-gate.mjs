import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeRetryFunding } from "../src/services/recovery-delivery-retry/funding-admission-gate.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("serializes same-shop retry funding before opening its transaction", async () => {
  const started = deferred();
  const release = deferred();
  const stages = [];
  const first = serializeRetryFunding("shop-a", async (waitMs) => {
    assert.ok(waitMs >= 0);
    stages.push("first-start");
    started.resolve();
    await release.promise;
    stages.push("first-end");
    return "reserved";
  });
  await started.promise;
  const second = serializeRetryFunding("shop-a", async (waitMs) => {
    assert.ok(waitMs >= 0);
    stages.push("second-start");
    return "revalidated";
  });
  // Different merchants are not globally serialized.
  await serializeRetryFunding("shop-b", async () => {
    stages.push("other-shop");
  });
  assert.deepEqual(stages, ["first-start", "other-shop"]);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [
    "reserved",
    "revalidated",
  ]);
  assert.deepEqual(stages, [
    "first-start",
    "other-shop",
    "first-end",
    "second-start",
  ]);
});

test("releases the shop gate on rejection and does not swallow the original error", async () => {
  const release = deferred();
  const original = new Error("original database error");
  const first = serializeRetryFunding("shop-c", async () => {
    await release.promise;
    throw original;
  });
  const checked = assert.rejects(first, (error) => error === original);
  const second = serializeRetryFunding("shop-c", async () => "next operation");
  release.resolve();
  await checked;
  assert.equal(await second, "next operation");
  assert.equal(
    await serializeRetryFunding("shop-c", async () => "later operation"),
    "later operation",
  );
});
