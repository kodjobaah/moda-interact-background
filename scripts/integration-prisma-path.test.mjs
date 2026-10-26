import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { localPrismaCliPath } from "./integration-prisma-path.mjs";

function withFixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "moda-integration-prisma-"));
  try {
    const localBin = path.join(root, "node_modules", ".bin");
    mkdirSync(localBin, { recursive: true });
    return run({ root, localBin });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("direct Node invocation resolves the installed local Prisma before a global CLI", {
  skip: process.platform === "win32",
}, () => withFixture(({ root, localBin }) => {
  const cli = path.join(localBin, "prisma");
  writeFileSync(cli, "#!/bin/sh\nprintf 'local-prisma:%s' \"$1\"\n", { mode: 0o755 });
  const configured = localPrismaCliPath(root, "/usr/bin:/bin");
  assert.equal(configured.split(path.delimiter)[0], localBin);
  assert.equal(configured, localPrismaCliPath(root, configured));

  const result = spawnSync("prisma", ["migrate"], {
    encoding: "utf8", env: { ...process.env, PATH: configured },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "local-prisma:migrate");
}));

test("missing local Prisma fails explicitly rather than falling back to a global CLI", () =>
  withFixture(({ root }) => {
    assert.throws(
      () => localPrismaCliPath(root, "/usr/local/bin:/usr/bin"),
      /Local Prisma CLI unavailable .*run npm ci/,
    );
  }));

test("a nonexecutable local Prisma fails closed", {
  skip: process.platform === "win32",
}, () => withFixture(({ root, localBin }) => {
  writeFileSync(path.join(localBin, "prisma"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  assert.throws(() => localPrismaCliPath(root, "/usr/bin"), /Local Prisma CLI unavailable/);
}));
