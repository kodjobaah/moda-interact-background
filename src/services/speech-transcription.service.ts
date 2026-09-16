export interface SpeechTranscriptionService {
  transcribe(input: { bytes: Uint8Array; mimeType: string }): Promise<{ text: string; provider: string; model: string }>;
}

export class SpeechTranscriptionError extends Error {
  constructor(readonly code: "configuration-missing" | "http" | "invalid-response", readonly retryable: boolean) {
    super(`groq-transcription-${code}`);
    this.name = "SpeechTranscriptionError";
  }
}

export class GroqSpeechTranscriptionService implements SpeechTranscriptionService {
  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  async transcribe(input: { bytes: Uint8Array; mimeType: string }) {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) throw new SpeechTranscriptionError("configuration-missing", false);
    const model = process.env.GROQ_TRANSCRIPTION_MODEL?.trim() || "whisper-large-v3-turbo";
    const form = new FormData();
    form.append("file", new Blob([input.bytes.buffer as ArrayBuffer], { type: input.mimeType }), "voice-note");
    form.append("model", model);
    const response = await this.fetchImplementation("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new SpeechTranscriptionError("http", response.status === 408 || response.status === 429 || response.status >= 500);
    let body: { text?: unknown };
    try {
      body = (await response.json()) as { text?: unknown };
    } catch {
      throw new SpeechTranscriptionError("invalid-response", false);
    }
    if (typeof body.text !== "string") throw new SpeechTranscriptionError("invalid-response", false);
    return { text: body.text, provider: "groq", model };
  }
}

export const groqSpeechTranscriptionService = new GroqSpeechTranscriptionService();