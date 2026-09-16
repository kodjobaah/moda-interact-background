const DEFAULT_API_BASE_URL = "https://graph.facebook.com/v25.0";
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export type DownloadedWhatsAppAudio = { bytes: Uint8Array; mimeType: string };

export class WhatsAppMediaService {
  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  async downloadAudio(mediaId: string, expectedMimeType: string | null): Promise<DownloadedWhatsAppAudio> {
    const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
    if (!token) throw new Error("whatsapp-media-configuration-missing");
    const base = (process.env.WHATSAPP_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    const metadata = await this.fetchImplementation(`${base}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!metadata.ok) throw new Error("whatsapp-media-metadata-rejected");
    const metadataBody = (await metadata.json()) as { url?: unknown; mime_type?: unknown };
    if (typeof metadataBody.url !== "string" || !metadataBody.url) throw new Error("whatsapp-media-url-missing");
    const mimeType = typeof metadataBody.mime_type === "string" ? metadataBody.mime_type : expectedMimeType;
    if (!mimeType?.toLowerCase().startsWith("audio/")) throw new Error("whatsapp-media-type-unsupported");
    const response = await this.fetchImplementation(metadataBody.url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) throw new Error("whatsapp-media-download-rejected");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_AUDIO_BYTES) throw new Error("whatsapp-media-too-large");
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { bytes, mimeType };
  }
}

export const whatsappMediaService = new WhatsAppMediaService();