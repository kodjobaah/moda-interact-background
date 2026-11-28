import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppInboundEvent } from "../../../../src/integration/whatsapp/types.js";
import {
  MAX_AUDIO_BYTES,
  WhatsAppMediaService,
} from "../../../../src/services/whatsapp-media.service.js";
import { MAX_DURATION_MS } from "../../../../src/services/inbound-whatsapp-audio.service.js";
import { sha256 } from "../../../../src/services/recovery-multipart/frozen.js";
import {
  prepareRoutingAudio,
  assertCurrentRoutingAudio,
  type RoutingAudioOperation,
  type RoutingAudioPorts,
} from "../../../../src/services/recovery-sender-pool/routing-audio.js";

const sourceSha256 = "a".repeat(64);
const scope = {
  threadId: "thread-a",
  routeId: "route-a",
  canonicalRecipient: "447700900123",
  providerAccountId: "101",
  providerPhoneNumberId: "502",
};
const event = (): WhatsAppInboundEvent => ({
  schemaVersion: 1,
  provider: "whatsapp",
  providerAccountId: "101",
  providerPhoneNumberId: "502",
  providerMessageId: "voice-a",
  customerPhone: "447700900123",
  contextMessageId: null,
  occurredAt: "2026-11-15T12:00:00Z",
  content: {
    type: "audio",
    mediaId: "media-a",
    mimeType: "audio/ogg",
    sha256: null,
    voice: true,
  },
});
const operation = (): RoutingAudioOperation => ({
  sender: {
    rowId: "sender-row",
    version: 3,
    environment: "test",
    providerAccountId: "101",
    providerPhoneNumberId: "501",
  },
  mediaCredential: { accessToken: "fixture-meta-secret" },
  speech: {
    provider: "groq",
    model: "whisper-large-v3",
    apiKey: "fixture-speech-secret",
  },
  operationRows: [
    { id: "sender-row", version: 3 },
    { id: "speech-row", version: 4 },
    { id: "provider-row", version: 5 },
  ],
});
const bytes = () =>
  Uint8Array.from(Buffer.from("OggS-fixture-audio-container"));
function ports() {
  return {
    readOperation: vi.fn().mockResolvedValue(operation()),
    assertCurrent: vi.fn().mockResolvedValue(undefined),
    download: vi
      .fn()
      .mockResolvedValue({ bytes: bytes(), mimeType: "audio/ogg" }),
    duration: vi.fn().mockResolvedValue(2000),
    transcribe: vi.fn().mockResolvedValue({
      text: "Can this arrive Friday?",
      provider: "groq",
      model: "whisper-large-v3",
    }),
  } satisfies RoutingAudioPorts;
}
describe("verified routing voice preparation", () => {
  it.each([
    undefined,
    null,
    "",
    "A".repeat(64),
    "a".repeat(63),
    "g".repeat(64),
  ])(
    "rejects missing or invalid durable source hash %s before reading configuration",
    async (hash) => {
      const deps = ports();
      await expect(
        prepareRoutingAudio(event(), scope, hash as string, deps),
      ).rejects.toThrow("ROUTING_AUDIO_DURABLE_SOURCE_HASH_REQUIRED");
      expect(deps.readOperation).not.toHaveBeenCalled();
      expect(deps.download).not.toHaveBeenCalled();
    },
  );
  it("returns exact transcript and secret-free immutable provenance without changing raw input", async () => {
    const raw = event();
    const before = structuredClone(raw);
    const deps = ports();
    const result = await prepareRoutingAudio(raw, scope, sourceSha256, deps);
    expect(raw).toEqual(before);
    expect(result.text).toBe("Can this arrive Friday?");
    expect(result.provenance).toEqual({
      schemaVersion: 1,
      verified: true,
      sourceSha256,
      providerMessageId: "voice-a",
      mediaIdSha256: sha256("media-a"),
      mediaSha256: null,
      transcriptSha256: sha256(result.text),
      provider: "groq",
      model: "whisper-large-v3",
      durationMs: 2000,
      operationRows: operation().operationRows,
    });
    expect(JSON.stringify(result.provenance)).not.toContain(
      "fixture-meta-secret",
    );
    expect(JSON.stringify(result.provenance)).not.toContain(
      "fixture-speech-secret",
    );
    expect(deps.assertCurrent).toHaveBeenCalledTimes(4);
    expect(deps.download).toHaveBeenCalledWith(
      "media-a",
      "audio/ogg",
      expect.objectContaining({
        accessToken: "fixture-meta-secret",
        assertCurrent: expect.any(Function),
      }),
    );
    expect(deps.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "audio/ogg" }),
      operation().speech,
    );
  });
  it("stops a credential rotation between metadata and media fetch using the existing downloader", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          url: "https://media.example.test/voice",
          mime_type: "audio/ogg",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const service = new WhatsAppMediaService(request);
    const assertCurrent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("configuration changed"));
    await expect(
      service.downloadAudio("media-a", "audio/ogg", {
        accessToken: "fixture-meta-secret",
        assertCurrent,
      }),
    ).rejects.toThrow("configuration changed");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["base64", "hex"])(
    "validates provider media SHA256 in %s encoding",
    async (encoding) => {
      const raw = event();
      if (raw.content.type === "audio")
        raw.content.sha256 = createHash("sha256")
          .update(bytes())
          .digest(encoding === "hex" ? "hex" : "base64");
      const result = await prepareRoutingAudio(
        raw,
        scope,
        sourceSha256,
        ports(),
      );
      expect(result.provenance.verified).toBe(true);
      expect(result.provenance.mediaSha256).toBe(
        raw.content.type === "audio" ? raw.content.sha256 : null,
      );
    },
  );
  it("rejects a changed receiving sender before any media I/O", async () => {
    const deps = ports();
    deps.assertCurrent.mockRejectedValue(new Error("sender changed"));
    await expect(
      prepareRoutingAudio(event(), scope, sourceSha256, deps),
    ).rejects.toThrow("sender changed");
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.transcribe).not.toHaveBeenCalled();
  });
  it("rejects changed configuration after download before transcription", async () => {
    const deps = ports();
    deps.assertCurrent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("configuration changed"));
    await expect(
      prepareRoutingAudio(event(), scope, sourceSha256, deps),
    ).rejects.toThrow("configuration changed");
    expect(deps.transcribe).not.toHaveBeenCalled();
  });
  it("rejects changed configuration after transcription without returning transcript evidence", async () => {
    const deps = ports();
    deps.assertCurrent
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("configuration changed"));
    await expect(
      prepareRoutingAudio(event(), scope, sourceSha256, deps),
    ).rejects.toThrow("configuration changed");
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
  });
  it.each([
    "empty",
    "oversized",
    "wrong-container",
    "changed-mime",
    "wrong-hash",
  ])(
    "refuses invalid %s media before paid transcription",
    async (condition) => {
      const raw = event();
      const deps = ports();
      if (condition === "empty")
        deps.download.mockResolvedValue({
          bytes: new Uint8Array(),
          mimeType: "audio/ogg",
        });
      if (condition === "oversized")
        deps.download.mockResolvedValue({
          bytes: new Uint8Array(MAX_AUDIO_BYTES + 1),
          mimeType: "audio/ogg",
        });
      if (condition === "wrong-container")
        deps.download.mockResolvedValue({
          bytes: Uint8Array.from([1, 2, 3, 4]),
          mimeType: "audio/ogg",
        });
      if (condition === "changed-mime" && raw.content.type === "audio")
        raw.content.mimeType = "audio/mpeg";
      if (condition === "wrong-hash" && raw.content.type === "audio")
        raw.content.sha256 = "0".repeat(64);
      await expect(
        prepareRoutingAudio(raw, scope, sourceSha256, deps),
      ).rejects.toThrow();
      expect(deps.transcribe).not.toHaveBeenCalled();
    },
  );
  it.each([0, -1, NaN, Infinity, MAX_DURATION_MS + 1])(
    "refuses unsafe duration %s before transcription",
    async (duration) => {
      const deps = ports();
      deps.duration.mockResolvedValue(duration);
      await expect(
        prepareRoutingAudio(event(), scope, sourceSha256, deps),
      ).rejects.toThrow("ROUTING_AUDIO_DURATION_INVALID");
      expect(deps.transcribe).not.toHaveBeenCalled();
    },
  );
  it.each([
    { text: " ", provider: "groq", model: "whisper-large-v3" },
    { text: "hello", provider: "openai", model: "whisper-large-v3" },
    { text: "hello", provider: "groq", model: "changed-model" },
  ])("rejects unavailable or mismatched transcript %j", async (transcript) => {
    const deps = ports();
    deps.transcribe.mockResolvedValue(transcript);
    await expect(
      prepareRoutingAudio(event(), scope, sourceSha256, deps),
    ).rejects.toThrow("ROUTING_AUDIO_TRANSCRIPT_INVALID");
  });
  it("requires audio rather than inventing a transcript for text", async () => {
    const deps = ports();
    await expect(
      prepareRoutingAudio(
        { ...event(), content: { type: "text", text: "hello" } },
        scope,
        sourceSha256,
        deps,
      ),
    ).rejects.toThrow("ROUTING_AUDIO_REQUIRED");
    expect(deps.readOperation).not.toHaveBeenCalled();
  });
});
describe("routing voice current sender and configuration proof", () => {
  const database = () => ({
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: "thread-a" }]),
  });
  it("permits a pooled non-default phone in the same current credential WABA", async () => {
    const db = database();
    await expect(
      assertCurrentRoutingAudio(db, event(), scope, operation()),
    ).resolves.toBeUndefined();
    expect(db.$queryRawUnsafe.mock.calls[0]?.slice(1)).toEqual([
      "thread-a",
      "447700900123",
      "502",
      "101",
      "route-a",
      "sender-row",
      "test",
      3,
      "speech-row",
      4,
      "provider-row",
      5,
    ]);
  });
  it.each([
    "foreign-waba",
    "foreign-phone",
    "foreign-recipient",
    "wrong-snapshot-waba",
    "wrong-row",
    "wrong-version",
    "duplicate-row",
  ])("rejects %s authority", async (condition) => {
    const db = database();
    let raw = event();
    const selected = structuredClone(operation());
    if (condition === "foreign-waba")
      raw = { ...raw, providerAccountId: "999" };
    if (condition === "foreign-phone")
      raw = { ...raw, providerPhoneNumberId: "999" };
    if (condition === "foreign-recipient")
      raw = { ...raw, customerPhone: "447700900999" };
    if (condition === "wrong-snapshot-waba")
      selected.sender.providerAccountId = "999";
    if (condition === "wrong-row") selected.operationRows[0]!.id = "other-row";
    if (condition === "wrong-version") selected.operationRows[0]!.version = 8;
    if (condition === "duplicate-row")
      selected.operationRows[2]!.id = selected.operationRows[1]!.id;
    await expect(
      assertCurrentRoutingAudio(db, raw, scope, selected),
    ).rejects.toThrow();
  });
  it("refuses missing current scope/config proof before network", async () => {
    const db = database();
    db.$queryRawUnsafe.mockResolvedValue([]);
    await expect(
      assertCurrentRoutingAudio(db, event(), scope, operation()),
    ).rejects.toThrow("ROUTING_AUDIO_CONFIGURATION_OR_SCOPE_CHANGED");
  });
});
