import { describe, expect, it, vi } from "vitest";
import { MetaImageHeaderSampleUploader, META_TEMPLATE_SAMPLE_URL } from "../../../../src/services/meta-template-management/image-header-sample.js";
import { ShopBrandMediaError } from "../../../../src/services/shop-brand-media/contracts.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0xff, 0xd9]);
const fetched = { bytes: jpeg, declaredContentType: "image/jpeg" };
const input = { appId: "123456789", accessToken: "test-token", graphBase: "https://graph.facebook.com/v25.0" };

function fetcher(result: typeof fetched = fetched) {
  return { fetch: vi.fn(async (url: string) => {
    expect(url).toBe(META_TEMPLATE_SAMPLE_URL);
    return result;
  }) };
}

describe("trusted Meta template image sample upload", () => {
  it("opens an app-scoped session and uploads exact JPEG bytes at offset zero", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "upload:abcdefgh" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ h: "4::Meta-issued-sample-handle" })));
    const sample = fetcher();
    const uploader = new MetaImageHeaderSampleUploader(request as typeof fetch, sample);
    await expect(uploader.upload(input)).resolves.toEqual({ value: "4::Meta-issued-sample-handle" });
    expect(sample.fetch).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    const [sessionUrl, sessionInit] = request.mock.calls[0] as unknown as [URL, RequestInit];
    expect(sessionUrl.pathname).toBe("/v25.0/123456789/uploads");
    expect(Object.fromEntries(sessionUrl.searchParams)).toEqual({
      file_length: String(jpeg.length), file_type: "image/jpeg", file_name: "moda-whatsapp-template-sample.jpeg",
    });
    expect(sessionInit.method).toBe("POST");
    expect(sessionInit.headers).toEqual({ Authorization: "OAuth test-token" });
    const [uploadUrl, uploadInit] = request.mock.calls[1] as unknown as [URL, RequestInit];
    expect(uploadUrl.pathname).toBe("/v25.0/upload:abcdefgh");
    expect(uploadInit.headers).toEqual(expect.objectContaining({ Authorization: "OAuth test-token", file_offset: "0" }));
    expect(Buffer.from(uploadInit.body as Uint8Array)).toEqual(jpeg);
  });

  it.each([
    [{ bytes: Buffer.from("not-jpeg"), declaredContentType: "image/jpeg" }, "META_SAMPLE_INVALID"],
    [{ bytes: jpeg, declaredContentType: "text/html" }, "META_SAMPLE_INVALID"],
    [{ bytes: Buffer.alloc(5_000_001), declaredContentType: "image/jpeg" }, "META_SAMPLE_INVALID"],
  ] as const)("rejects a sample with invalid MIME, JPEG signature or size", async (image, code) => {
    const request = vi.fn();
    const uploader = new MetaImageHeaderSampleUploader(request as typeof fetch, fetcher(image));
    await expect(uploader.upload(input)).rejects.toMatchObject({ code });
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed on missing app identity and malformed session or handle", async () => {
    const noRequest = vi.fn();
    const uploader = new MetaImageHeaderSampleUploader(noRequest as typeof fetch, fetcher());
    await expect(uploader.upload({ ...input, appId: "" })).rejects.toMatchObject({ code: "META_APP_CONFIGURATION_INVALID" });
    expect(noRequest).not.toHaveBeenCalled();

    const badSession = new MetaImageHeaderSampleUploader(vi.fn(async () => new Response(JSON.stringify({ id: "12345" }))) as typeof fetch, fetcher());
    await expect(badSession.upload(input)).rejects.toMatchObject({ code: "META_UPLOAD_SESSION_INVALID" });
    const badHandle = new MetaImageHeaderSampleUploader(vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "upload:abcdefgh" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ h: "https://not-a-handle.example" }))) as typeof fetch, fetcher());
    await expect(badHandle.upload(input)).rejects.toMatchObject({ code: "META_UPLOAD_HANDLE_INVALID" });
  });

  it("retains safe original Meta error code/message while redacting echoed credentials", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: {
      message: "Invalid access token test-token; please reconnect", code: 190, error_subcode: 463,
      error_data: { detail: "Authorization: Bearer test-token" }, fbtrace_id: "trace-123",
    } }), { status: 401, headers: { "x-fb-request-id": "request-456" } }));
    const uploader = new MetaImageHeaderSampleUploader(request as typeof fetch, fetcher());
    const failure = await uploader.upload(input).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "META_SAMPLE_SESSION_REJECTED", disposition: "blocked", diagnostics: expect.objectContaining({
        origin: "provider_response", providerErrorCode: 190, providerErrorSubcode: 463,
        providerErrorMessage: "Invalid access token [REDACTED]; please reconnect", providerRequestId: "request-456",
        redactionApplied: true,
      }),
    });
    expect(JSON.stringify(failure)).not.toContain("test-token");
  });

  it.each([
    [429, "rate limited"],
    [503, "upload backend unavailable"],
  ])("classifies Meta upload HTTP %i as retryable and preserves its source failure", async (status, message) => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "upload:abcdefgh" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message, code: 2, error_subcode: 99 } }), { status }));
    const uploader = new MetaImageHeaderSampleUploader(request as typeof fetch, fetcher());
    const failure = await uploader.upload(input).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      disposition: "uncertain", diagnostics: expect.objectContaining({ operation: "sample_upload",
        httpStatus: status, providerErrorCode: 2, providerErrorSubcode: 99, providerErrorMessage: message }),
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new ShopBrandMediaError("SOURCE_TIMEOUT", true), "uncertain", "META_SAMPLE_FETCH_SOURCE_TIMEOUT"],
    [new ShopBrandMediaError("UNSAFE_SOURCE", false), "blocked", "META_SAMPLE_FETCH_UNSAFE_SOURCE"],
  ] as const)("preserves retryability for a controlled sample-fetch failure", async (fetchError, disposition, code) => {
    const request = vi.fn();
    const uploader = new MetaImageHeaderSampleUploader(request as typeof fetch,
      { fetch: vi.fn(async () => { throw fetchError; }) });
    await expect(uploader.upload(input)).rejects.toMatchObject({ code, disposition });
    expect(request).not.toHaveBeenCalled();
  });

  it("logs a bounded original SDK exception while redacting token-bearing transport text", async () => {
    const request = vi.fn(async () => { throw new Error("TLS failed for Bearer test-token at https://graph.example/path"); });
    const uploader = new MetaImageHeaderSampleUploader(request as typeof fetch, fetcher());
    const failure = await uploader.upload(input).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "META_SAMPLE_SESSION_TRANSPORT", disposition: "uncertain",
      diagnostics: expect.objectContaining({ origin: "sdk_exception", errorName: "Error", redactionApplied: true }) });
    expect(JSON.stringify(failure)).not.toContain("test-token");
    expect(JSON.stringify(failure)).not.toContain("https://graph.example");
  });
});
