import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createSafeImageFetcher, type ImageHttpResponse } from "../../../../src/services/shop-brand-media/safe-fetch.js";

const publicAnswer = [{ address: "8.8.8.8", family: 4 as const }];
const response = (input: {
  statusCode?: number; content?: Buffer; location?: string; peerAddress?: string;
  headers?: Record<string, string>;
} = {}): ImageHttpResponse => ({
  statusCode: input.statusCode ?? 200,
  headers: { "content-type": "text/plain; charset=UTF-8",
    ...(input.location ? { location: input.location } : {}), ...input.headers },
  body: Readable.from([input.content ?? Buffer.from("not really a JPEG")]),
  peerAddress: input.peerAddress ?? "8.8.8.8",
});

const open = (setup: Parameters<typeof createSafeImageFetcher>[0] = {}) => createSafeImageFetcher({
  resolveAll: async () => publicAnswer,
  request: async () => response(),
  ...setup,
});

describe("ARCH-049 brand source DNS-pinned HTTPS fetch", () => {
  it("does not trust Content-Type, pins DNS and streams exact source bytes", async () => {
    const request = vi.fn(async () => response({ content: Buffer.from("actual-source-bytes"),
      headers: { "content-type": "image/png" } }));
    expect(await open({ request }).fetch("https://cdn.shop.test/path/image.webp?version=3"))
      .toEqual({ bytes: Buffer.from("actual-source-bytes"), declaredContentType: "image/png" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      hostname: "cdn.shop.test", path: "/path/image.webp?version=3",
      address: publicAnswer[0], servername: "cdn.shop.test",
    }), expect.any(AbortSignal));
  });

  it.each([
    "http://public.test/image.png", "https://user:secret@public.test/image.png",
    "https://public.test:8443/image.png", "https://public.test/image.png#fragment",
    "https://127.0.0.1/test.png", "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/test", "https://[::ffff:127.0.0.1]/test",
    `https://public.test/path${String.fromCharCode(1)}unsafe`,
  ])("rejects unsafe source %s", async (url) => {
    const request = vi.fn(async () => response());
    await expect(open({ request }).fetch(url)).rejects.toMatchObject({ code: "UNSAFE_SOURCE" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects mixed public/private answers on the same hostname (DNS rebinding)", async () => {
    const request = vi.fn(async () => response());
    await expect(open({ resolveAll: async () => [...publicAnswer,
      { address: "10.0.0.5", family: 4 }], request }).fetch("https://shop.test/image"))
      .rejects.toMatchObject({ code: "UNSAFE_SOURCE" });
    expect(request).not.toHaveBeenCalled();
  });

  it("re-resolves every hop; blocks redirects to metadata/private addresses", async () => {
    const request = vi.fn(async () => response({ statusCode: 302,
      location: "https://169.254.169.254/secrets" }));
    const resolver = vi.fn(async () => publicAnswer);
    await expect(open({ request, resolveAll: resolver }).fetch("https://cdn.shop.test/logo"))
      .rejects.toMatchObject({ code: "UNSAFE_SOURCE" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("checks fresh DNS answers after a same-host redirect instead of reusing an earlier pin", async () => {
    let lookups = 0;
    const request = vi.fn(async () => response({ statusCode: 302, location: "/next" }));
    const resolver = async () => (++lookups === 1 ? publicAnswer :
      [{ address: "169.254.169.254", family: 4 as const }]);
    await expect(open({ resolveAll: resolver, request }).fetch("https://shop.test/logo"))
      .rejects.toMatchObject({ code: "UNSAFE_SOURCE" });
    expect(lookups).toBe(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("enforces three redirects and forbids a fourth", async () => {
    const request = vi.fn(async () => response({ statusCode: 302, location: "/next" }));
    await expect(open({ request }).fetch("https://cdn.shop.test/start"))
      .rejects.toMatchObject({ code: "UNSAFE_SOURCE" });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("rejects a peer address different from its pinned DNS answer", async () => {
    await expect(open({ request: async () => response({ peerAddress: "1.1.1.1" }) })
      .fetch("https://cdn.shop.test/logo")).rejects.toMatchObject({ code: "UNSAFE_SOURCE" });
  });

  it("caps both declared and streamed input at 10 MiB", async () => {
    await expect(open({ request: async () => response({ headers: { "content-length": "10485761" } }) })
      .fetch("https://cdn.shop.test/logo")).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
    await expect(open({ request: async () => response({ content: Buffer.alloc(10 * 1024 * 1024 + 1) }) })
      .fetch("https://cdn.shop.test/logo")).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
  });

  it("does not decompress content-encoded responses before the image/pixel cap", async () => {
    await expect(open({ request: async () => response({ headers: { "content-encoding": "gzip" } }) })
      .fetch("https://cdn.shop.test/logo")).rejects.toMatchObject({ code: "UNSUPPORTED_ENCODING" });
  });

  it("classifies temporary DNS and provider 429 as retryable without leaking a source URL", async () => {
    await expect(open({ resolveAll: async () => { throw Object.assign(new Error("secret-url"), { code: "EAI_AGAIN" }); } })
      .fetch("https://cdn.shop.test/logo?secret=yes")).rejects.toMatchObject({ code: "DNS_TEMPORARY_FAILURE", retryable: true });
    await expect(open({ request: async () => response({ statusCode: 429 }) })
      .fetch("https://cdn.shop.test/logo")).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE", retryable: true });
  });
});
