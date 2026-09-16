import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppMediaError, WhatsAppMediaService } from "../../../src/services/whatsapp-media.service.js";

describe("WhatsAppMediaService", () => {
  beforeEach(() => {
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  });

  it.each([408, 429, 500, 503])("classifies HTTP %s as retryable", async (status) => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(null, { status }));

    await expect(new WhatsAppMediaService(fetchImplementation).downloadAudio("media-1", "audio/ogg"))
      .rejects.toMatchObject<Partial<WhatsAppMediaError>>({ code: "metadata-http", retryable: true });
  });

  it("classifies unsupported media as terminal", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "https://provider.invalid/media", mime_type: "image/jpeg" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(new WhatsAppMediaService(fetchImplementation).downloadAudio("media-1", "audio/ogg"))
      .rejects.toMatchObject<Partial<WhatsAppMediaError>>({ code: "media-type-unsupported", retryable: false });
  });
});