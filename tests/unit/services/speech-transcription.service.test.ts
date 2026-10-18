import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platformOperationalPolicyReader } from "../../../src/services/platform-operational-policy.js";
import { GroqSpeechTranscriptionService, OpenAISpeechTranscriptionService, speechTranscriptionService } from "../../../src/services/speech-transcription.service.js";

vi.mock("../../../src/services/platform-operational-policy.js", () => ({
  platformOperationalPolicyReader: { transcription: vi.fn() },
}));
const policy = {provider:"groq" as const,groqModelId:"whisper-large-v3-turbo",openaiModelId:"gpt-4o-mini-transcribe"};
const input = { bytes: new Uint8Array([99, 1, 2, 99]).subarray(1, 3), mimeType: "audio/ogg; codecs=opus" };
beforeEach(() => { vi.mocked(platformOperationalPolicyReader.transcription).mockResolvedValue(policy); vi.stubEnv("GROQ_API_KEY", "test-groq"); vi.stubEnv("WHATSAPP_OPENAI_API_KEY", "test-openai"); vi.stubEnv("OPENAI_TRANSCRIPTION_MODEL", ""); vi.stubEnv("GROQ_TRANSCRIPTION_MODEL", ""); vi.stubEnv("WHATSAPP_TRANSCRIPTION_PROVIDER", ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("spoken-language transcription", () => {
  it.each(["Bonjour, pouvez-vous vérifier ma commande ?", "Can you check my order please?"])("V01 preserves provider transcript %s without language or translation instructions", async (text) => {
    const fetcher = vi.fn(async () => Response.json({text}));
    const result = await new OpenAISpeechTranscriptionService(fetcher as typeof fetch).transcribe(input);
    expect(result).toEqual({text, provider:"openai", model:"gpt-4o-mini-transcribe"});
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const form = init.body as FormData;
    expect([...form.keys()].sort()).toEqual(["file", "model", "response_format"]);
    const file = form.get("file") as File;
    expect(file.name).toBe("voice-note.ogg"); expect(file.type).toBe(input.mimeType);
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1,2]);
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
  });
  it("uses the trusted database policy and fails closed on policy errors", async () => {
    const fetcher = vi.fn(async () => Response.json({ text: "bonjour" }));
    const groq = await new GroqSpeechTranscriptionService(fetcher as typeof fetch).transcribe(input);
    expect(groq).toMatchObject({ provider: "groq", model: "whisper-large-v3-turbo" });
    vi.stubEnv("GROQ_API_KEY", "");
    await expect(speechTranscriptionService.transcribe(input)).rejects.toMatchObject({ code: "configuration-missing" });
    vi.mocked(platformOperationalPolicyReader.transcription).mockRejectedValueOnce(new Error("private DB error"));
    await expect(speechTranscriptionService.transcribe(input)).rejects.toMatchObject({ code: "configuration-invalid" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("uses the selected OpenAI model from the policy", async () => {
    const fetcher = vi.fn(async () => Response.json({ text: "Hello" }));
    const selected = { ...policy, provider: "openai" as const, openaiModelId: "gpt-4o-transcribe" };
    expect(await new OpenAISpeechTranscriptionService(fetcher as typeof fetch).transcribe(input, selected))
      .toMatchObject({ model: "gpt-4o-transcribe" });
  });
  it.each([[400,false],[401,false],[408,true],[429,true],[503,true]])("V05 bounds HTTP %s without retrying or changing provider",async(status,retryable)=>{
    const fetcher=vi.fn(async()=>new Response("private provider detail",{status:status as number}));
    await expect(new OpenAISpeechTranscriptionService(fetcher as typeof fetch).transcribe(input)).rejects.toMatchObject({code:"http",retryable,message:"speech-transcription-http"});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("V05 sanitizes network failures and installs the existing 60-second deadline",async()=>{
    const timeout=vi.spyOn(AbortSignal,"timeout");
    const fetcher=vi.fn(async()=>{throw new Error("secret headers or raw SDK details");});
    await expect(new OpenAISpeechTranscriptionService(fetcher as typeof fetch).transcribe(input)).rejects.toMatchObject({code:"network",retryable:true,message:"speech-transcription-network"});
    expect(timeout).toHaveBeenCalledWith(60_000); timeout.mockRestore();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["audio/aac", "application/octet-stream"])("V03 rejects unsupported %s before provider",async(mimeType)=>{
    const fetcher=vi.fn();
    await expect(new OpenAISpeechTranscriptionService(fetcher).transcribe({...input,mimeType})).rejects.toMatchObject({code:"unsupported-media",retryable:false});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{}, {text:7}, {text:"x".repeat(64_001)}])("rejects malformed/oversized responses",async(body)=>{
    await expect(new OpenAISpeechTranscriptionService(vi.fn(async()=>Response.json(body)) as typeof fetch).transcribe(input)).rejects.toMatchObject({code:"invalid-response",retryable:false});
  });
});
