// Root operator only; no provider transport. Build first; default is read-only.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MetaThrottlePreclaimRecovery, THROTTLE_ATTESTATION } from '../dist/services/meta-template-management/throttle-recovery.js';
import { parsePreclaimRecoveryArguments } from '../dist/services/meta-template-management/preclaim-recovery.js';
import prisma from '../dist/lib/db.js';
let receipt;
try {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    if (args.indexOf(flag, index + 1) !== -1 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('RECOVERY_ARGUMENTS_INVALID');
    const value = args[index + 1]; args.splice(index, 2); return value;
  };
  const evidencePath = get('--external-evidence');
  const reference = get('--evidence-reference');
  const operation = get('--evidence-operation');
  const attest = args.indexOf('--attest-exact-code4');
  if (attest >= 0) args.splice(attest, 1);
  const options = parsePreclaimRecoveryArguments(args);
  const recovery = new MetaThrottlePreclaimRecovery();
  if (options.mode === 'plan') {
    if (!evidencePath || !reference || !['sample_session', 'sample_upload'].includes(operation) || attest < 0) throw new Error('RECOVERY_EXTERNAL_EVIDENCE_REQUIRED');
    const bytes = await readFile(evidencePath);
    if (bytes.length > 2_000_000) throw new Error('RECOVERY_EVIDENCE_TOO_LARGE');
    receipt = await recovery.plan(options.ids, options.operator, options.proof, {
      sha256: createHash('sha256').update(bytes).digest('hex'), reference, operation,
      attestation: THROTTLE_ATTESTATION, httpStatus: 403, providerErrorCode: 4, registrationIds: options.ids,
    });
  } else {
    if (evidencePath || reference || operation || attest >= 0) throw new Error('RECOVERY_ARGUMENTS_INVALID');
    const file = await readFile(options.path, 'utf8');
    if (Buffer.byteLength(file) > 65536) throw new Error('RECOVERY_MANIFEST_TOO_LARGE');
    receipt = await recovery.recover(JSON.parse(file), { apply: options.apply, ...(options.digest ? { digest: options.digest } : {}) });
  }
} catch (error) {
  receipt = { outcome: 'refused', code: error instanceof Error && /^RECOVERY_[A-Z_]+$/.test(error.message) ? error.message : 'RECOVERY_REFUSED' };
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
console.log(JSON.stringify(receipt));
