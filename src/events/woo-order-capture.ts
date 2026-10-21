import { createHash } from "node:crypto";
import type { Job } from "bullmq";
import { z } from "zod";

/** API-019 owns the wire format; this is Background's independent, strict
 * capture-only queue-boundary validator. It never consumes Shopify order jobs. */
export const WOO_ORDER_CAPTURE_QUEUE = "woo-order-capture-v1";
export const WOO_ORDER_CAPTURE_JOB = "order-lifecycle";

const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/);
const timestamp = z.string().max(30).regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  .refine((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  });
const order = z.strictObject({
  orderId: opaqueId,
  checkoutKey: opaqueId,
  status: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]{0,63}$/),
});
const eventFields = {
  schemaVersion: z.literal("woo.activity.v1"),
  eventId: opaqueId,
  eventType: z.enum(["ORDER_PLACED", "ORDER_PAID", "ORDER_CANCELLED"]),
  checkoutKey: opaqueId,
  occurredAt: timestamp,
  order,
};
const jobData = z.strictObject({
  ...eventFields,
  shopId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type WooOrderCapture = Omit<z.infer<typeof jobData>, "contentDigest">;
export type WooOrderCaptureJob = Pick<Job, "id" | "name" | "data">;

export class InvalidWooOrderCaptureJob extends Error {
  constructor(readonly reason: "invalid_job_name" | "invalid_payload" | "job_identity_mismatch" | "digest_mismatch") {
    super("Invalid Woo order capture job");
  }
}

/** No checkout or payment inference. Preserve ORDER_PLACED / PAID / CANCELLED
 * independently, and reject cross-shop job IDs or content tampering. */
export function parseWooOrderCaptureJob(job: WooOrderCaptureJob): WooOrderCapture {
  if (job.name !== WOO_ORDER_CAPTURE_JOB) {
    throw new InvalidWooOrderCaptureJob("invalid_job_name");
  }
  const parsed = jobData.safeParse(job.data);
  if (!parsed.success) throw new InvalidWooOrderCaptureJob("invalid_payload");

  const { shopId, contentDigest, ...validatedEvent } = parsed.data;
  if (validatedEvent.checkoutKey !== validatedEvent.order.checkoutKey ||
      Buffer.byteLength(JSON.stringify(validatedEvent)) > 65_536) {
    throw new InvalidWooOrderCaptureJob("invalid_payload");
  }
  const expectedId = `woo-order-${createHash("sha256")
    .update(shopId).update("\0").update(validatedEvent.eventId).digest("hex")}`;
  if (job.id !== expectedId) throw new InvalidWooOrderCaptureJob("job_identity_mismatch");

  const expectedDigest = createHash("sha256")
    .update(JSON.stringify(validatedEvent)).digest("hex");
  if (contentDigest !== expectedDigest) throw new InvalidWooOrderCaptureJob("digest_mismatch");
  return { ...validatedEvent, shopId };
}
