import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WHATSAPP_API_BASE_URL,
  WHATSAPP_SEND_TIMEOUT_MS,
  WhatsAppService,
} from "../../../src/services/whatsapp.service.js";

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

  it("keeps WABA identity separate from the sender phone identity", () => {
    const service = new WhatsAppService();

    expect(service.getProviderAccountId()).toBe(businessAccountId);
    expect(service.resolveSender()).toEqual({
      providerAccountId: businessAccountId,
      providerPhoneNumberId: phoneNumberId,
    });
  });

  it.each(["WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_PHONE_NUMBER_ID"])(
    "fails boundedly when %s is missing",
    (variable) => {
    vi.stubEnv(variable, "");

    expect(() => new WhatsAppService().resolveSender()).toThrowError(
      expect.objectContaining({ code: "configuration-missing" }),
    );
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
});