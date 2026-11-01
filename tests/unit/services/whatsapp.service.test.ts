import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WHATSAPP_API_BASE_URL,
  WHATSAPP_SEND_TIMEOUT_MS,
  WhatsAppService,
} from "../../../src/services/whatsapp.service.js";

vi.mock("../../../src/services/platform-configuration/consumers.js", () => ({
  platformConsumerConfiguration: {
    read: async () => ({ value: {
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
      businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "",
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
    } }),
  },
}));

const phoneNumberId = "test-phone-number-id";
const businessAccountId = "test-waba-id";
const accessToken = "test-access-token";
const input = {
  to: "15551234567",
  text: "Hello from Moda",
};

describe("WhatsAppService API base URL", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", businessAccountId);
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", phoneNumberId);
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", accessToken);
  });

  it.each([undefined, "", "   "])(
    "uses the production Graph API default when base URL is %s",
    async (baseUrl) => {
      if (baseUrl !== undefined) {
        vi.stubEnv("WHATSAPP_API_BASE_URL", baseUrl);
      }
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid-default" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

      const result = await new WhatsAppService(fetchMock).sendWhatsAppText(input);

      expect(result).toEqual({ providerMessageId: "wamid-default" });
      expect(fetchMock).toHaveBeenCalledWith(
        `${DEFAULT_WHATSAPP_API_BASE_URL}/${phoneNumberId}/messages`,
        expect.objectContaining({
          method: "POST",
          signal: expect.any(AbortSignal),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }),
      );
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
        messaging_product: "whatsapp",
        to: input.to,
        type: "text",
        text: { body: input.text },
      });
    },
  );

  it.each([
    "http://127.0.0.1:45678",
    "http://127.0.0.1:45678/",
    "http://127.0.0.1:45678///",
  ])("uses custom base URL without duplicate slash: %s", async (baseUrl) => {
    vi.stubEnv("WHATSAPP_API_BASE_URL", baseUrl);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid-custom" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await new WhatsAppService(fetchMock).sendWhatsAppText(input);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://127.0.0.1:45678/${phoneNumberId}/messages`,
    );
  });

  it.each([
    {
      canonicalLanguageTag: "en-GB",
      providerLanguageCode: "en_GB",
      templateName: "checkout_recovery_en_gb",
    },
    {
      canonicalLanguageTag: "fr-CA",
      providerLanguageCode: "fr_CA_CUSTOM",
      templateName: "checkout_recovery_fr_ca",
    },
  ])("sends the selected provider template fields unchanged", async ({
    canonicalLanguageTag,
    providerLanguageCode,
    templateName,
  }) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid-template" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await new WhatsAppService(fetchMock).sendWhatsAppTemplate({
      to: input.to,
      templateName,
      languageCode: providerLanguageCode,
    });

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(
      (fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted,
    ).toBe(false);
    expect(WHATSAPP_SEND_TIMEOUT_MS).toBe(30_000);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body).toMatchObject({
      type: "template",
      template: {
        name: templateName,
        language: { code: providerLanguageCode },
      },
    });
    expect(body.template.language.code).not.toBe(canonicalLanguageTag);
  });

  it("keeps WABA identity separate from the sender phone identity", async () => {
    const service = new WhatsAppService();

    expect(await service.getProviderAccountId()).toBe(businessAccountId);
    expect(await service.resolveSender()).toEqual({
      providerAccountId: businessAccountId,
      providerPhoneNumberId: phoneNumberId,
    });
  });

  it.each(["WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_PHONE_NUMBER_ID"])(
    "fails boundedly when %s is missing",
    async (variable) => {
    vi.stubEnv(variable, "");

    await expect(new WhatsAppService().resolveSender()).rejects.toMatchObject({
      code: "configuration-missing",
    });
    },
  );

  it("fails boundedly when the access token is missing", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "");

    await expect(new WhatsAppService().sendWhatsAppText(input)).rejects.toMatchObject({
      code: "configuration-missing",
    });
  });

  it("serializes preview URLs and reply context only when requested", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid-text" }] }), { status: 200 }),
    );

    await new WhatsAppService(fetchMock).sendWhatsAppText({
      ...input,
      text: "Open https://example.myshopify.com/cart/1",
      previewUrl: true,
      replyToProviderMessageId: "wamid-inbound",
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      text: {
        body: "Open https://example.myshopify.com/cart/1",
        preview_url: true,
      },
      context: { message_id: "wamid-inbound" },
    });
  });

  it("serializes approved image header and dynamic URL button components", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid-template" }] }), { status: 200 }),
    );

    await new WhatsAppService(fetchMock).sendWhatsAppTemplate({
      to: input.to,
      templateName: "recovery",
      languageCode: "en_US",
      bodyParameters: ["Ada"],
      imageHeader: { link: "https://cdn.example.com/recovery.png" },
      dynamicUrlButton: { index: 0, text: "checkout-token" },
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).template.components).toEqual([
      {
        type: "header",
        parameters: [{ type: "image", image: { link: "https://cdn.example.com/recovery.png" } }],
      },
      { type: "body", parameters: [{ type: "text", text: "Ada" }] },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: "checkout-token" }],
      },
    ]);
  });

  it("serializes approved dynamic URL buttons in order with their own indexes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid-template" }] }), { status: 200 }),
    );

    await new WhatsAppService(fetchMock).sendWhatsAppTemplate({
      to: input.to,
      templateName: "alternative_product_recovery",
      languageCode: "en_US",
      dynamicUrlButtons: [
        { index: 0, text: "checkout-token" },
        { index: 1, text: "product-token" },
      ],
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).template.components).toEqual([
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: "checkout-token" }],
      },
      {
        type: "button",
        sub_type: "url",
        index: "1",
        parameters: [{ type: "text", text: "product-token" }],
      },
    ]);
  });

  it("rejects duplicate dynamic URL button indexes before provider dispatch", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(new WhatsAppService(fetchMock).sendWhatsAppTemplate({
      to: input.to,
      templateName: "invalid_template",
      languageCode: "en_US",
      dynamicUrlButtons: [
        { index: 0, text: "checkout-token" },
        { index: 0, text: "product-token" },
      ],
    })).rejects.toMatchObject({ code: "invalid-template-input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not invent components for a static approved template URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid-static" }] }), { status: 200 }),
    );

    await new WhatsAppService(fetchMock).sendWhatsAppTemplate({
      to: input.to,
      templateName: "static-link",
      languageCode: "en_US",
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).template).toEqual({
      name: "static-link",
      language: { code: "en_US" },
    });
  });

  it.each([
    { method: "sendWhatsAppText", providerCode: 131026, expected: "131026" },
    { method: "sendWhatsAppTemplate", providerCode: "131026", expected: "131026" },
  ])("preserves only the bounded provider code for $method", async ({ method, providerCode, expected }) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: { code: providerCode, message: "do not retain" } }), { status: 400 }),
    );
    const service = new WhatsAppService(fetchMock);

    await expect(method === "sendWhatsAppText"
      ? service.sendWhatsAppText(input)
      : service.sendWhatsAppTemplate({ to: input.to, templateName: "recovery", languageCode: "en_US" }))
      .rejects.toMatchObject({ code: "provider-rejected", providerCode: expected });
    await expect(method === "sendWhatsAppText"
      ? service.sendWhatsAppText(input)
      : service.sendWhatsAppTemplate({ to: input.to, templateName: "recovery", languageCode: "en_US" }))
      .rejects.not.toMatchObject({ message: "do not retain" });
  });

  it("ignores unbounded provider codes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: { code: "131026".repeat(10) } }), { status: 400 }),
    );

    await expect(new WhatsAppService(fetchMock).sendWhatsAppText(input))
      .rejects.toMatchObject({ code: "provider-rejected", providerCode: undefined });
  });

  it("logs the original bounded Meta failure and redacts echoed secrets and customer data", async () => {
    const logger = { error: vi.fn() };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: {
      message: "Distinct Meta rejection for customer +447700900123 token=secret-value https://shop.test/checkout",
      code: 131026,
      error_subcode: 77,
      error_data: { details: "delivery window", phone: "+447700900123", api_token: "secret-value" },
      fbtrace_id: "trace-meta-123",
    } }), {
      status: 400,
      headers: { "content-type": "application/json", "x-fb-request-id": "request-meta-123" },
    }));

    await expect(new WhatsAppService(fetchMock, logger).sendWhatsAppTemplate({
      to: input.to, templateName: "recovery", languageCode: "en_US",
    })).rejects.toMatchObject({ code: "provider-rejected", providerCode: "131026" });

    expect(logger.error).toHaveBeenCalledWith("whatsapp.meta.send.failed", expect.objectContaining({
      origin: "provider_response", provider: "meta", operation: "sendWhatsAppTemplate",
      reasonCode: "META_SEND_FAILED", httpStatus: 400, providerRequestId: "request-meta-123",
      providerError: expect.objectContaining({
        message: expect.stringContaining("Distinct Meta rejection for customer [REDACTED]"),
        code: 131026, error_subcode: 77, fbtrace_id: "trace-meta-123",
        error_data: { details: "delivery window" },
      }),
      redactionApplied: true,
    }));
    const fields = logger.error.mock.lastCall?.[1];
    expect(JSON.stringify(fields)).not.toContain("secret-value");
    expect(JSON.stringify(fields)).not.toContain("shop.test");
    expect(JSON.stringify(fields)).not.toContain("+447700900123");
  });

  it("logs the original SDK cause chain without inventing a provider error", async () => {
    const logger = { error: vi.fn() };
    const cause = new Error("socket closed after request");
    const failure = new Error("transport failed token=secret-value", { cause });
    const fetchMock = vi.fn<typeof fetch>(async () => { throw failure; });

    await expect(new WhatsAppService(fetchMock, logger).sendWhatsAppTemplate({
      to: input.to, templateName: "recovery", languageCode: "en_US",
    })).rejects.toBe(failure);

    expect(logger.error).toHaveBeenCalledWith("whatsapp.meta.send.failed", expect.objectContaining({
      origin: "sdk_exception", provider: "meta", operation: "sendWhatsAppTemplate",
      sourceError: { name: "Error", message: "transport failed token=[REDACTED]" },
      causeChain: [{ name: "Error", message: "socket closed after request" }],
    }));
    expect(logger.error.mock.lastCall?.[1]).not.toHaveProperty("providerError");
    expect(JSON.stringify(logger.error.mock.lastCall?.[1])).not.toContain("secret-value");
  });
  it.each(["sendWhatsAppText", "sendWhatsAppTemplate"] as const)(
    "treats a non-JSON HTTP rejection as definitive without inventing a Meta code (%s)", async (method) => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        new Response("gateway error without JSON", { status: 400 }));
      const service = new WhatsAppService(fetchMock);
      const call = method === "sendWhatsAppText"
        ? service.sendWhatsAppText(input)
        : service.sendWhatsAppTemplate({ to: input.to, templateName: "test", languageCode: "en" });
      await expect(call).rejects.toMatchObject({
        name: "WhatsAppServiceError", code: "provider-rejected", providerCode: undefined,
      });
    },
  );

});