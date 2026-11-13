// Operator-only: no worker imports or provider transport. Build before running.
import { readFile } from 'node:fs/promises';
import { MetaPreclaimRecovery, parsePreclaimRecoveryArguments } from '../dist/services/meta-template-management/preclaim-recovery.js';
import prisma from '../dist/lib/db.js';

let receipt;
try {
  const options = parsePreclaimRecoveryArguments(process.argv.slice(2));
  const recovery = new MetaPreclaimRecovery();
  if (options.mode === 'plan') {
    receipt = await recovery.plan(options.ids, options.operator, options.proof);
  } else {
    const file = await readFile(options.path, 'utf8');
    if (Buffer.byteLength(file) > 32_768) throw new Error('RECOVERY_MANIFEST_TOO_LARGE');
    receipt = await recovery.recover(JSON.parse(file), { apply: options.apply, ...(options.digest ? { digest: options.digest } : {}) });
  }
} catch (error) {
  // Bounded codes only: never echo source, credential/config payloads or raw DB errors.
  const code = error instanceof Error && /^RECOVERY_[A-Z_]+$/.test(error.message) ? error.message : 'RECOVERY_REFUSED';
  receipt = { outcome: 'refused', code };
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
console.log(JSON.stringify(receipt));
