import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppService, WhatsAppServiceError } from "../../../src/services/whatsapp.service.js";
import { RecoveryOutreachAttemptService } from "../../../src/services/recovery-outreach-attempt.service.js";

vi.mock("../../../src/lib/db.js", () => ({ default: {} }));

// Server-only test policy replacing the production PostgreSQL sender lookup.
vi.mock("../../../src/services/platform-configuration/consumers.js", () => ({
  platformConsumerConfiguration: {
    read: vi.fn(async () => ({
      value: { accessToken: "test-only-not-a-real-token", businessAccountId: "business-test", phoneNumberId: "phone-test" },
    })),
  },
}));

// Downstream trace in Background (as of B005):
// RecoveryPolicyService.resolve -> RecoveryOutreachAttemptService.getOrCreate
//   -> RecoveryOutreachAttempt.offerSnapshot (Prisma JSON).
// OutboundMessageDeliveryService.sendPreparedText -> WhatsAppService.sendWhatsAppText
//   -> JSON.stringify({type:"text",text:{body}}) -> Meta Graph API.
// No Background composer currently reads offerSnapshot and inserts the coupon
// into an outbound text/template. These tests verify the two existing boundaries;
// they are NOT a completed end-to-end coupon-delivery integration test.
// WhatsApp Cloud API text bodies have a provider-defined 4096-character ceiling.
const WHATSAPP_TEXT_BODY_MAX_CHARACTERS = 4096;
const TOKEN = "test-only-not-a-real-token";

afterEach(() => vi.unstubAllEnvs());

function configure() {
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", TOKEN);
  vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", "business-test");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "phone-test");
  vi.stubEnv("WHATSAPP_API_BASE_URL", "https://graph.example.test/v25.0");
}

function captureProvider(httpStatus = 200) {
  const payloads: unknown[] = [];
  const fetcher: typeof fetch = vi.fn<typeof fetch>(async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify(httpStatus === 200 ? { messages: [{ id: "wamid.mock" }] } : { error: { code: 131008 } }),
      { status: httpStatus, headers: { "content-type": "application/json" } },
    );
  });
  return { service: new WhatsAppService(fetcher), payloads };
}

function requestBody(captured: unknown): string {
  const payload = captured as { type: string; text: { body: string } };
  expect(payload.type).toBe("text");
  return payload.text.body;
}

describe("ARCH-036 BACKGROUND-005 downstream Woo coupon code boundaries", () => {
  it("passes a >255-character Woo code through the real recovery snapshot persistence input", async () => {
    const code = "W".repeat(300);
    const upsert = vi.fn(async ({ create }: { create: Record<string, unknown> }) => create);
    const storage = new RecoveryOutreachAttemptService({
      recoveryOutreachAttempt: { upsert },
    } as never);
    const saved = await storage.getOrCreate({
      recoveryId: "recovery-test", sequence: 1, recipient: "+447000000000",
      policy: {
        recoveryOfferMode: "FIXED", fixedShopifyDiscountId: "discount-test",
        offerSnapshot: { singleRedeemCode: code, shopifyDiscountNodeId: "woo:coupon:123" },
      } as never,
    });
    const snapshot = saved.offerSnapshot as unknown as { singleRedeemCode: string };
    expect(snapshot.singleRedeemCode).toBe(code);
    expect(JSON.parse(JSON.stringify(snapshot)).singleRedeemCode).toBe(code);
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("transmits >255 characters and exactly 4096 characters untruncated in a WhatsApp text JSON envelope", async () => {
    configure();
    const { service, payloads } = captureProvider();
    for (const length of [300, WHATSAPP_TEXT_BODY_MAX_CHARACTERS]) {
      const message = "W".repeat(length);
      await expect(service.sendWhatsAppText({ to: "+447000000000", text: message }))
        .resolves.toEqual({ providerMessageId: "wamid.mock" });
      expect(requestBody(payloads.at(-1))).toBe(message);
    }
    expect(payloads).toHaveLength(2);
  });

  it("propagates a provider rejection beyond the 4096-character text envelope without silently truncating", async () => {
    configure();
    // Simulate the external provider enforcing its documented text limit. This
    // is NOT a live Meta request or proof about the template parameter limit.
    const { service, payloads } = captureProvider(400);
    const oversized = "W".repeat(WHATSAPP_TEXT_BODY_MAX_CHARACTERS + 1);
    try {
      await service.sendWhatsAppText({ to: "+447000000000", text: oversized });
      throw new Error("Provider should reject the oversized text envelope");
    } catch (error) {
      expect(error).toBeInstanceOf(WhatsAppServiceError);
      expect((error as WhatsAppServiceError).code).toBe("provider-rejected");
    }
    expect(requestBody(payloads[0])).toBe(oversized);
  });
});
