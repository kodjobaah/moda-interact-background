import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

/** A platform guidance reply has no shop/conversation to lock. This transaction-
 * scoped recipient lock serializes its final STOP read with the STOP writer.
 * Only a hash-derived, signed int64 reaches PostgreSQL; never log the phone.
 * STOP takes this lock before Shop locks; other outbound shop/conversation locks
 * never attempt this recipient lock, so they cannot create an inverted cycle.
 */
export async function lockWhatsAppStopRecipient(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  canonical: string,
): Promise<void> {
  if (!/^[1-9][0-9]{1,14}$/.test(canonical))
    throw new Error("INVALID_WHATSAPP_RECIPIENT");
  const key = createHash("sha256")
    .update(`moda:whatsapp:stop-guidance:v1:${canonical}`)
    .digest()
    .readBigInt64BE(0);
  // Materialization forces the volatile lock function to run, and returns an
  // ordinary integer instead of PostgreSQL's unsupported 'void' wire type.
  await tx.$queryRawUnsafe<Array<{ acquired: number }>>(`
    WITH recipient_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock($1::bigint)
    )
    SELECT COUNT(*)::integer AS "acquired" FROM recipient_lock
  `, key);
}
