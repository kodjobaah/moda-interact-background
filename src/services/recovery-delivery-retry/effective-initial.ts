import type { PrismaClient } from "@prisma/client";
import { hasConfirmedOutreachDelivery, selectEffectiveOutreachAttempt } from "../../domain/recovery-outreach-identity.js";
import { recoveryOutreachIdentitySelect } from "./outreach-selection.js";

/** Original paths retain their established projection. Once any retry exists,
 * an automated follow-up may only use the positively delivered chain head. */
export async function effectiveInitialForFollowUp<T extends { id: string; sequence: number }>(
  db: Pick<PrismaClient, "recoveryOutreachAttempt">, recoveryId: string, conversationId: string | null,
  attempts: readonly T[],
): Promise<T | undefined> {
  if (!attempts.some(a => a.sequence >= 3)) return attempts.find(a => a.sequence === 1);
  if (!conversationId) return undefined;
  const rows = await db.recoveryOutreachAttempt.findMany({ where: { checkoutRecoveryId: recoveryId }, select: recoveryOutreachIdentitySelect });
  const selected = selectEffectiveOutreachAttempt({ recoveryId, conversationId, slot: "INITIAL", attempts: rows });
  if (selected.kind !== "selected" || !hasConfirmedOutreachDelivery(selected.current, conversationId)) return undefined;
  return attempts.find(a => a.id === selected.current.id);
}
