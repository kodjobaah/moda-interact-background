import {
  brotliCompressSync,
  deflateSync,
  gzipSync,
} from "node:zlib";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type MerchantKnowledgeHttpResponse,
  type MerchantKnowledgeHttpsRequest,
  type MerchantKnowledgePinnedRequest,
  MERCHANT_KNOWLEDGE_ACQUISITION_ERROR_CODES,
  MerchantKnowledgeWebPageAcquirer,
} from "../../../src/services/merchant-knowledge-web-page-acquirer.js";
import { MERCHANT_KNOWLEDGE_MAX_DECOMPRESSED_BYTES } from "../../../src/services/merchant-knowledge-network-policy.js";

const PUBLIC_ADDRESS = { address: "8.8.8.8", family: 4 as const };

function response(
  body: string | Buffer,
  options: {
    statusCode?: number;
    headers?: MerchantKnowledgeHttpResponse["headers"];
    peerAddress?: string;
  } = {},
): MerchantKnowledgeHttpResponse {
  return {
    statusCode: options.statusCode ?? 200,
    headers: options.headers ?? { "content-type": "text/plain; charset=UTF-8" },
    body: Readable.from([body]),
    peerAddress: options.peerAddress ?? PUBLIC_ADDRESS.address,
  };
}

function acquirer(
  replies: MerchantKnowledgeHttpResponse[],
  options: {
    resolveAll?: ConstructorParameters<typeof MerchantKnowledgeWebPageAcquirer>[0]["resolveAll"];
    request?: MerchantKnowledgeHttpsRequest;
  } = {},
) {
  const requests: MerchantKnowledgePinnedRequest[] = [];
  const request = options.request ?? (async (target) => {
    requests.push(target);
    const next = replies.shift();
    if (!next) throw new Error("Missing fake response");
    return next;
  });
  return {
    client: new MerchantKnowledgeWebPageAcquirer({
      resolveAll: options.resolveAll ?? (async () => [PUBLIC_ADDRESS]),
      request,
    }),
    requests,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MerchantKnowledgeWebPageAcquirer", () => {
  it.each([
    ["http://example.com", "INVALID_URL"],
    ["https://user:pass@example.com", "INVALID_URL"],
    [`https://example.com/${"a".repeat(2049)}`, "INVALID_URL"],
    ["https://127.0.0.1/", "DENIED_DESTINATION"],
    ["https://192.168.1.1/", "DENIED_DESTINATION"],
    ["https://169.254.169.254/latest/meta-data/", "DENIED_DESTINATION"],
    ["https://[::1]/", "DENIED_DESTINATION"],
    ["https://[fc00::1]/", "DENIED_DESTINATION"],
  ])("rejects unsafe URL %s before sending a request", async (url, code) => {
    const harness = acquirer([]);
    await expect(harness.client.acquire({ requestedUrl: url })).rejects.toMatchObject({
      code,
    });
    expect(harness.requests).toHaveLength(0);
  });

  it("uses only the selected validated address and bounded generic headers", async () => {
    const harness = acquirer([response("ok")]);
    await harness.client.acquire({ requestedUrl: "https://example.com/path?q=1" });
    expect(harness.requests[0]).toMatchObject({
      hostname: "example.com",
      path: "/path?q=1",
      address: PUBLIC_ADDRESS,
      servername: "example.com",
      headers: {
        Accept: "text/html, text/plain",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": "ModaInteract-MerchantKnowledge/1.0",
      },
    });
    expect(Object.keys(harness.requests[0]!.headers).sort()).toEqual(
      ["Accept", "Accept-Encoding", "User-Agent"].sort(),
    );
  });

  it("rejects a connected peer that differs from the selected address", async () => {
    const harness = acquirer([
      response("ok", { peerAddress: "8.8.4.4" }),
    ]);
    await expect(
      harness.client.acquire({ requestedUrl: "https://example.com" }),
    ).rejects.toMatchObject({ code: "CONNECTION_PEER_MISMATCH" });
  });

  it("rejects a mixed public and special-use DNS answer before making a request", async () => {
    const request = vi.fn(async () => response("must not be requested"));
    const harness = acquirer([], {
      resolveAll: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "192.31.196.1", family: 4 },
      ],
      request,
    });

    await expect(
      harness.client.acquire({ requestedUrl: "https://mixed.example/" }),
    ).rejects.toMatchObject({ code: "DENIED_DESTINATION", retryable: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a mixed public and special-use IPv6 DNS answer before making a request", async () => {
    const request = vi.fn(async () => response("must not be requested"));
    const harness = acquirer([], {
      resolveAll: async () => [
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "2620:4f:8000::1", family: 6 },
      ],
      request,
    });

    await expect(
      harness.client.acquire({ requestedUrl: "https://mixed-ipv6.example/" }),
    ).rejects.toMatchObject({
      code: "DENIED_DESTINATION",
      retryable: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves each redirect independently and returns the final URL", async () => {
    const resolver = vi.fn(async (hostname: string) =>
      hostname === "first.example"
        ? [{ address: "8.8.8.8", family: 4 as const }]
        : [{ address: "1.1.1.1", family: 4 as const }],
    );
    const harness = acquirer(
      [
        response("", {
          statusCode: 302,
          headers: {
            location: "https://second.example/final",
            "content-type": "text/plain",
          },
        }),
        response("done", { peerAddress: "1.1.1.1" }),
      ],
      { resolveAll: resolver },
    );
    const result = await harness.client.acquire({
      requestedUrl: "https://first.example/start",
    });
    expect(result).toMatchObject({
      contentType: "text/plain",
      extractedText: "done",
      resolvedUrl: "https://second.example/final",
    });
    expect(result.fetchedAt).toBeInstanceOf(Date);
    expect(resolver.mock.calls.map(([hostname]) => hostname)).toEqual([
      "first.example",
      "second.example",
    ]);
    expect(harness.requests).toHaveLength(2);
  });

  it("rejects redirects to private destinations before connecting", async () => {
    const resolver = vi.fn(async (hostname: string) =>
      hostname === "public.example"
        ? [{ address: "8.8.8.8", family: 4 as const }]
        : [{ address: "10.0.0.1", family: 4 as const }],
    );
    const harness = acquirer(
      [
        response("", {
          statusCode: 302,
          headers: { location: "https://private.example/" },
        }),
      ],
      { resolveAll: resolver },
    );
    await expect(
      harness.client.acquire({ requestedUrl: "https://public.example/" }),
    ).rejects.toMatchObject({ code: "DENIED_DESTINATION" });
    expect(harness.requests).toHaveLength(1);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("rejects a sixth redirect", async () => {
    const redirects = Array.from({ length: 6 }, () =>
      response("", {
        statusCode: 302,
        headers: { location: "/again", "content-type": "text/plain" },
      }),
    );
    const harness = acquirer(redirects);
    await expect(
      harness.client.acquire({ requestedUrl: "https://example.com/" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS", retryable: false });
    expect(harness.requests).toHaveLength(6);
  });

  it("enforces one overall acquisition deadline", async () => {
    vi.useFakeTimers();
    const request = vi.fn(
      (_target: MerchantKnowledgePinnedRequest, _signal: AbortSignal) =>
        new Promise<MerchantKnowledgeHttpResponse>(() => undefined),
    );
    const harness = acquirer([], { request });
    const pending = harness.client.acquire({ requestedUrl: "https://8.8.8.8" });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "REQUEST_DEADLINE",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("rejects decompressed content over 1 MiB", async () => {
    const compressed = gzipSync(
      Buffer.alloc(MERCHANT_KNOWLEDGE_MAX_DECOMPRESSED_BYTES + 1, 0x61),
    );
    const harness = acquirer([
      response(compressed, {
        headers: {
          "content-type": "text/plain",
          "content-encoding": "gzip",
        },
      }),
    ]);
    await expect(
      harness.client.acquire({ requestedUrl: "https://example.com" }),
    ).rejects.toMatchObject({ code: "BODY_TOO_LARGE", retryable: false });
  });

  it("accepts a body exactly at the decompressed limit", async () => {
    const harness = acquirer([
      response(Buffer.alloc(MERCHANT_KNOWLEDGE_MAX_DECOMPRESSED_BYTES, 0x61), {
        headers: { "content-type": "text/plain" },
      }),
    ]);
    const result = await harness.client.acquire({ requestedUrl: "https://example.com" });
    expect(result.extractedText).toHaveLength(MERCHANT_KNOWLEDGE_MAX_DECOMPRESSED_BYTES);
  });

  it.each([
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ])("decodes supported %s content encoding", async (encoding, compress) => {
    const harness = acquirer([
      response(compress(Buffer.from("compressed text")), {
        headers: {
          "content-type": "text/plain",
          "content-encoding": encoding,
        },
      }),
    ]);
    const result = await harness.client.acquire({ requestedUrl: "https://example.com" });
    expect(result.extractedText).toBe("compressed text");
  });

  it("classifies malformed compressed data as a permanent read failure", async () => {
    const harness = acquirer([
      response("not gzip", {
        headers: {
          "content-type": "text/plain",
          "content-encoding": "gzip",
        },
      }),
    ]);
    await expect(
      harness.client.acquire({ requestedUrl: "https://example.com" }),
    ).rejects.toMatchObject({ code: "RESPONSE_READ_FAILED", retryable: false });
  });

  it.each([
    [{ "content-type": "application/pdf" }, "UNSUPPORTED_MEDIA_TYPE"],
    [
      { "content-type": "text/plain", "content-encoding": "compress" },
      "UNSUPPORTED_CONTENT_ENCODING",
    ],
    [
      { "content-type": "text/plain", "content-encoding": "gzip, br" },
      "UNSUPPORTED_CONTENT_ENCODING",
    ],
  ])("rejects unsupported response metadata", async (headers, code) => {
    const harness = acquirer([response("body", { headers })]);
    await expect(
      harness.client.acquire({ requestedUrl: "https://example.com" }),
    ).rejects.toMatchObject({ code, retryable: false });
  });

  it.each([
    [404, "HTTP_STATUS_PERMANENT", false],
    [429, "HTTP_STATUS_TRANSIENT", true],
    [503, "HTTP_STATUS_TRANSIENT", true],
  ])("classifies final HTTP status %s", async (statusCode, code, retryable) => {
    const harness = acquirer([response("", { statusCode })]);
    await expect(
      harness.client.acquire({ requestedUrl: "https://example.com" }),
    ).rejects.toMatchObject({ code, retryable });
  });

  it("returns plain text unchanged except UTF-8 replacement decoding", async () => {
    const harness = acquirer([
      response(Buffer.from([0x41, 0xff, 0x0d, 0x0a]), {
        headers: { "content-type": "text/plain" },
      }),
    ]);
    const result = await harness.client.acquire({ requestedUrl: "https://example.com" });
    expect(result.extractedText).toBe("A�\r\n");
  });

  it("exports a bounded acquisition error-code set", () => {
    expect(MERCHANT_KNOWLEDGE_ACQUISITION_ERROR_CODES).toContain("HTTP_STATUS_TRANSIENT");
    expect(MERCHANT_KNOWLEDGE_ACQUISITION_ERROR_CODES).not.toContain("EAI_AGAIN");
  });
});