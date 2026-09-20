export interface SpeechTranscriptionService {
  transcribe(input: { bytes: Uint8Array; mimeType: string }): Promise<{ text: string; provider: string; model: string }>;
}

type FailureCode = "configuration-missing" | "configuration-invalid" | "unsupported-media" | "http" | "network" | "invalid-response";
export class SpeechTranscriptionError extends Error {
  constructor(readonly code: FailureCode, readonly retryable: boolean) {
    super(`speech-transcription-${code}`);
    this.name = "SpeechTranscriptionError";
  }
}

const extensions: Record<string, string> = {
  "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3",
  "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/flac": "flac", "audio/x-flac": "flac", "audio/webm": "webm",
};
export function transcriptionFilename(mimeType: string): string {
  const extension = extensions[mimeType.split(";")[0]!.trim().toLowerCase()];
  if (!extension) throw new SpeechTranscriptionError("unsupported-media", false);
  return `voice-note.${extension}`;
}

/** Reject a MIME/container mismatch before sending bytes to a paid provider. */
export function validateTranscriptionMedia(input: { bytes: Uint8Array; mimeType: string }): void {
  const extension = transcriptionFilename(input.mimeType).split(".").pop();
  const b = input.bytes;
  const text = (start: number, size: number) => String.fromCharCode(...b.subarray(start, start + size));
  const valid = extension === "ogg" ? text(0, 4) === "OggS"
    : extension === "wav" ? text(0, 4) === "RIFF" && text(8, 4) === "WAVE"
    : extension === "flac" ? text(0, 4) === "fLaC"
    : extension === "m4a" ? text(4, 4) === "ftyp"
    : extension === "webm" ? [0x1a, 0x45, 0xdf, 0xa3].every((v, i) => b[i] === v)
    : extension === "mp3" ? text(0, 3) === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)
    : false;
  if (!valid) throw new SpeechTranscriptionError("unsupported-media", false);
}

class ProviderSpeechTranscriptionService implements SpeechTranscriptionService {
  constructor(private readonly provider: "groq" | "openai", private readonly fetchImplementation: typeof fetch = fetch) {}

  async transcribe(input: { bytes: Uint8Array; mimeType: string }) {
    const openai = this.provider === "openai";
    const apiKey = (openai ? process.env.WHATSAPP_OPENAI_API_KEY : process.env.GROQ_API_KEY)?.trim();
    if (!apiKey) throw new SpeechTranscriptionError("configuration-missing", false);
    const model = (openai ? process.env.OPENAI_TRANSCRIPTION_MODEL : process.env.GROQ_TRANSCRIPTION_MODEL)?.trim()
      || (openai ? "gpt-4o-mini-transcribe" : "whisper-large-v3-turbo");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) throw new SpeechTranscriptionError("configuration-invalid", false);
    const filename = transcriptionFilename(input.mimeType);
    if (!input.bytes.length || input.bytes.length > 15 * 1024 * 1024) throw new SpeechTranscriptionError("unsupported-media", false);
    const form = new FormData();
    // Copy only the supplied view, never unrelated bytes in its backing buffer.
    form.append("file", new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), filename);
    form.append("model", model);
    form.append("response_format", "json");
    // No language hint and no translation endpoint: preserve the spoken language.
    try {
      const response = await this.fetchImplementation(openai
        ? "https://api.openai.com/v1/audio/transcriptions"
        : "https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new SpeechTranscriptionError("http", response.status === 408 || response.status === 429 || response.status >= 500);
      let body: unknown;
      try { body = await response.json(); } catch { throw new SpeechTranscriptionError("invalid-response", false); }
      if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string" || body.text.length > 64_000)
        throw new SpeechTranscriptionError("invalid-response", false);
      return { text: body.text, provider: this.provider, model };
    } catch (error) {
      if (error instanceof SpeechTranscriptionError) throw error;
      // Never propagate provider responses, request headers or SDK/network details.
      throw new SpeechTranscriptionError("network", true);
    }
  }
}
export class GroqSpeechTranscriptionService extends ProviderSpeechTranscriptionService {
  constructor(fetchImplementation: typeof fetch = fetch) { super("groq", fetchImplementation); }
}
export class OpenAISpeechTranscriptionService extends ProviderSpeechTranscriptionService {
  constructor(fetchImplementation: typeof fetch = fetch) { super("openai", fetchImplementation); }
}
export const groqSpeechTranscriptionService = new GroqSpeechTranscriptionService();
const openAISpeechTranscriptionService = new OpenAISpeechTranscriptionService();
export const speechTranscriptionService: SpeechTranscriptionService = {
  transcribe(input) {
    const provider = process.env.WHATSAPP_TRANSCRIPTION_PROVIDER?.trim() || "groq";
    if (provider === "groq") return groqSpeechTranscriptionService.transcribe(input);
    if (provider === "openai") return openAISpeechTranscriptionService.transcribe(input);
    throw new SpeechTranscriptionError("configuration-invalid", false);
  },
};
