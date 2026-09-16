const DEFAULT_API_BASE_URL = "https://graph.facebook.com/v25.0";
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export type DownloadedWhatsAppAudio = { bytes: Uint8Array; mimeType: string };

export type WhatsAppMediaErrorCode =
  | "configuration-missing"
  | "metadata-http"
  | "metadata-invalid"
  | "media-type-unsupported"
  | "download-http"
  | "download-too-large"
  | "network";

export class WhatsAppMediaError extends Error {
  constructor(
    readonly code: WhatsAppMediaErrorCode,
    readonly retryable: boolean,
  ) {
    super(`whatsapp-media-${code}`);
    this.name = "WhatsAppMediaError";
  }
}

export class WhatsAppMediaService {
  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  async downloadAudio(mediaId: string, expectedMimeType: string | null): Promise<DownloadedWhatsAppAudio> {
    const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
    if (!token) throw new WhatsAppMediaError("configuration-missing", false);
    const base = (process.env.WHATSAPP_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    let metadata: Response;
    try {
      metadata = await this.fetchImplementation(`${base}/${encodeURIComponent(mediaId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new WhatsAppMediaError("network", true);
    }
    if (!metadata.ok) throw new WhatsAppMediaError("metadata-http", isRetryableStatus(metadata.status));
    let metadataBody: { url?: unknown; mime_type?: unknown };
    try {
      metadataBody = (await metadata.json()) as { url?: unknown; mime_type?: unknown };
    } catch {
      throw new WhatsAppMediaError("metadata-invalid", false);
    }
    if (typeof metadataBody.url !== "string" || !metadataBody.url) throw new WhatsAppMediaError("metadata-invalid", false);
    const mimeType = typeof metadataBody.mime_type === "string" ? metadataBody.mime_type : expectedMimeType;
    if (!mimeType?.toLowerCase().startsWith("audio/")) throw new WhatsAppMediaError("media-type-unsupported", false);
    let response: Response;
    try {
      response = await this.fetchImplementation(metadataBody.url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new WhatsAppMediaError("network", true);
    }
    if (!response.ok) throw new WhatsAppMediaError("download-http", isRetryableStatus(response.status));
    if (!response.body) throw new WhatsAppMediaError("metadata-invalid", false);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_AUDIO_BYTES) throw new WhatsAppMediaError("download-too-large", false);
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

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}