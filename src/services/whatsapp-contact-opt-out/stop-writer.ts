import { createHash } from "node:crypto";
import { MerchantSupportMessageKind, MerchantSupportMessageState, Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { matchesRegisteredPhone } from "./phone.js";

type StopDatabase = Pick<PrismaClient, "$transaction" | "merchantSupportThread" | "merchantSupportMessage">;
type ActivePhone = {
  id: string; phone: string; whatsappCanonicalPhone: string | null;
  whatsappNoContact: boolean; whatsappNoContactReason: string | null;
  whatsappNoContactRevision: bigint;
  customer: { shopId: string; shop: { defaultCountryCode: string | null } };
};
export type StopNotice = { shopId: string; sourceKey: string; reference: string };
export type StopWriteResult = { changed: number; notices: StopNotice[] };

function matching(rows: ActivePhone[], canonical: string): ActivePhone[] {
  return rows.filter((phone) => matchesRegisteredPhone(
    phone, canonical, phone.customer.shop.defaultCountryCode,
  ));
}

/** Transactionally applies STOP across the entire current registered-phone set.
 * Shop locks coordinate with the final recovery provider fence. Cross-shop locks
 * are acquired in stable order. Provider consent fields are never modified.
 */
export async function writeLocalStop(
  database: StopDatabase,
  input: { canonical: string; shopId: string | null; eventId: string; at: Date },
): Promise<StopWriteResult> {
  return database.$transaction(async (tx) => {
    const where: Prisma.CustomerPhoneWhereInput = {
      endedAt: null,
      OR: [{ whatsappCanonicalPhone: input.canonical }, { whatsappCanonicalPhone: null }],
      ...(input.shopId ? { customer: { shopId: input.shopId } } : {}),
    };
    const select = {
      id: true, phone: true, whatsappCanonicalPhone: true,
      whatsappNoContact: true, whatsappNoContactReason: true, whatsappNoContactRevision: true,
      customer: { select: { shopId: true, shop: { select: { defaultCountryCode: true } } } },
    } as const;
    const candidates = matching(await tx.customerPhone.findMany({ where, select }), input.canonical);
    const shopIds = [...new Set(candidates.map((record) => record.customer.shopId))].sort();
    for (const shopId of shopIds) {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, shopId);
    }
    // Read again under the Shop locks; do not rely on pre-lock snapshots.
    const locked = matching(await tx.customerPhone.findMany({ where, select }), input.canonical)
      .filter((record) => shopIds.includes(record.customer.shopId));
    let changed = 0;
    for (const phone of locked) {
      if (phone.whatsappNoContact && phone.whatsappNoContactReason === "CUSTOMER_STOP") continue;
      const result = await tx.customerPhone.updateMany({
        where: {
          id: phone.id, endedAt: null, whatsappNoContactRevision: phone.whatsappNoContactRevision,
        },
        data: {
          whatsappNoContact: true,
          whatsappNoContactReason: "CUSTOMER_STOP",
          whatsappNoContactAt: input.at,
          whatsappNoContactRevision: { increment: 1 },
        },
      });
      if (result.count !== 1) throw new Error("STOP_RECORD_CONFLICT");
      changed++;
    }
    const notices: StopNotice[] = shopIds.map((shopId) => {
      const first = locked.filter((record) => record.customer.shopId === shopId)
        .map((record) => record.id).sort()[0]!;
      // Stable opaque identity based on a random durable record ID, not raw PII.
      const reference = createHash("sha256")
        .update(`whatsapp-stop:v1:${shopId}:${first}`).digest("hex");
      const eventDigest = createHash("sha256")
        .update(`whatsapp-stop-event:v1:${shopId}:${input.eventId}`).digest("hex");
      return { shopId, reference: reference.slice(0, 16), sourceKey: `whatsapp-stop:v1:${eventDigest}` };
    });
    return { changed, notices };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** Notices happen AFTER STOP commits: a support failure never rolls back a STOP.
 * The inbound BullMQ job retries; sourceKey upserts make partial retries safe.
 */
export async function publishStopNotices(
  database: StopDatabase,
  notices: StopNotice[],
  scope: "QUOTED_SHOP" | "ALL_REGISTERED_SHOPS",
): Promise<void> {
  for (const notice of notices) {
    await database.$transaction(async (tx) => {
      const thread = await tx.merchantSupportThread.upsert({
        where: { shopId: notice.shopId },
        create: { shopId: notice.shopId }, update: {},
      });
      const at = new Date();
      const inserted = await tx.merchantSupportMessage.createMany({
        skipDuplicates: true,
        data: [{
          threadId: thread.id,
          kind: MerchantSupportMessageKind.SYSTEM,
          state: MerchantSupportMessageState.AVAILABLE,
          sourceLanguageTag: "en-GB", systemCode: "WHATSAPP_CUSTOMER_STOP",
          systemVersion: "1", sourceKey: notice.sourceKey, availableAt: at,
          originalBody: scope === "QUOTED_SHOP"
            ? `A customer has replied STOP to this shop's WhatsApp message. Sending to that registered number is prohibited. Reference: ${notice.reference}.`
            : `A standalone or unresolved-reference WhatsApp STOP has prohibited sending to this shop's registered number. Reference: ${notice.reference}.`,
        }],
      });
      if (inserted.count === 1) await tx.merchantSupportThread.update({
        where: { id: thread.id }, data: { lastMessageAt: at },
      });
    });
  }
}
