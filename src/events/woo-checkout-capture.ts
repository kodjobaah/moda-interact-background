import { createHash } from "node:crypto";
import type { Job } from "bullmq";
import { z } from "zod";

/** API-008 owns this wire format. This is the strict Background queue-boundary
 * validator, not a Shopify recovery event or a new cross-service contract. */
export const WOO_CHECKOUT_CAPTURE_QUEUE = "woo-checkout-capture-v1";
export const WOO_CHECKOUT_CAPTURE_JOB = "checkout-updated";

const safeText = (limit: number) => z.string().min(1).max(limit).regex(/^[^\p{Cc}]*$/u);
const opaqueId = safeText(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/);
const money = safeText(14).regex(/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/);
const timestamp = z.string().max(30).regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  .refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  });
const item = z.strictObject({
  quantity: z.number().int().min(1).max(100_000),
  productId: safeText(128).optional(),
  variationId: safeText(128).optional(),
  sku: safeText(128).optional(),
  title: safeText(200).optional(),
  unitPrice: money.optional(),
  total: money.optional(),
});
const contact = z.strictObject({
  email: safeText(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).refine((value) => !value.includes("<")).optional(),
  phone: safeText(32).regex(/^\+?[0-9 ()-]{5,32}$/).optional(),
  firstName: safeText(100).optional(),
  lastName: safeText(100).optional(),
});
const event = z.strictObject({
  schemaVersion: z.literal("woo.activity.v1"),
  eventId: opaqueId,
  eventType: z.literal("CHECKOUT_UPDATED"),
  checkoutKey: opaqueId,
  occurredAt: timestamp,
  checkout: z.strictObject({
    currency: z.string().regex(/^[A-Z]{3}$/),
    total: money,
    items: z.array(item).max(50).optional(),
    contact: contact.optional(),
  }),
});
const jobData = event.extend({
  shopId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type WooCheckoutCapture = z.infer<typeof event> & { shopId: string };
export type WooCheckoutCaptureJob = Pick<Job, "id" | "name" | "data">;

export class InvalidWooCheckoutCaptureJob extends Error {
  constructor(readonly reason: "invalid_job_name" | "invalid_payload" | "job_identity_mismatch" | "digest_mismatch") {
    super("Invalid Woo checkout capture job");
  }
}

/** Reject unknown fields, wrong source/version, tampered content and shop/job
 * identity mismatches. The API has already authenticated the shop; there is no
 * reason to perform a write or create a recovery merely to acknowledge capture. */
export function parseWooCheckoutCaptureJob(job: WooCheckoutCaptureJob): WooCheckoutCapture {
  if (job.name !== WOO_CHECKOUT_CAPTURE_JOB) {
    throw new InvalidWooCheckoutCaptureJob("invalid_job_name");
  }
  const parsed = jobData.safeParse(job.data);
  if (!parsed.success) throw new InvalidWooCheckoutCaptureJob("invalid_payload");

  const { shopId, contentDigest, ...validatedEvent } = parsed.data;
  if (Buffer.byteLength(JSON.stringify(validatedEvent)) > 65_536) {
    throw new InvalidWooCheckoutCaptureJob("invalid_payload");
  }
  const expectedId = `woo-checkout-${createHash("sha256")
    .update(shopId).update("\0").update(validatedEvent.eventId).digest("hex")}`;
  if (job.id !== expectedId) throw new InvalidWooCheckoutCaptureJob("job_identity_mismatch");

  const expectedDigest = createHash("sha256")
    .update(JSON.stringify(validatedEvent)).digest("hex");
  if (expectedDigest !== contentDigest) {
    throw new InvalidWooCheckoutCaptureJob("digest_mismatch");
  }
  return { ...validatedEvent, shopId };
}
