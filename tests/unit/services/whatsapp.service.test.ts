import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WHATSAPP_API_BASE_URL,
  WhatsAppService,
} from "../../../src/services/whatsapp.service.js";

const phoneNumberId = "test-phone-number-id";
const accessToken = "test-access-token";
const input = {
  to: "15551234567",
  text: "Hello from Moda",
};

describe("WhatsAppService API base URL", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
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
});