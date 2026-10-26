import { accessSync, constants } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * The Shared disposable-infrastructure helper launches `prisma migrate deploy`
 * as a subprocess. A direct `node scripts/test-integration.mjs` invocation does
 * not receive npm's automatic node_modules/.bin PATH entry. Resolve the local
 * dev dependency explicitly; never fall back silently to an unrelated global
 * Prisma CLI with potentially incompatible migration semantics.
 *
 * Return a PATH value so the runner remains the sole owner of the temporary
 * process-environment change. No database/Redis lifecycle is duplicated here.
 */
export function localPrismaCliPath(
  repositoryRoot,
  currentPath = process.env.PATH,
  platform = process.platform,
) {
  const localBin = path.join(repositoryRoot, "node_modules", ".bin");
  const cliName = platform === "win32" ? "prisma.cmd" : "prisma";
  try {
    accessSync(
      path.join(localBin, cliName),
      platform === "win32" ? constants.F_OK : constants.X_OK,
    );
  } catch (cause) {
    throw new Error(
      `Local Prisma CLI unavailable (node_modules/.bin/${cliName}); run npm ci before disposable integration tests.`,
      { cause },
    );
  }

  const existing = (currentPath ?? "").split(path.delimiter).filter(Boolean);
  return [localBin, ...existing.filter((entry) => entry !== localBin)]
    .join(path.delimiter);
}
