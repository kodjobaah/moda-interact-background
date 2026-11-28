import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

/** Shared by allocation and release across processes. Never log recipient/key. */
export async function lockRecoverySenderRecipient(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  canonicalRecipient: string,
): Promise<void> {
  if (!/^[1-9][0-9]{0,14}$/.test(canonicalRecipient))
    throw new Error("INVALID_SENDER_POOL_RECIPIENT");
  const key = createHash("sha256")
    .update(`moda:recovery-sender-pool:v1:${canonicalRecipient}`)
    .digest()
    .readBigInt64BE(0);
  await tx.$queryRawUnsafe(
    `WITH locked AS MATERIALIZED (SELECT pg_advisory_xact_lock($1::bigint)) SELECT COUNT(*)::integer FROM locked`,
    key,
  );
}
