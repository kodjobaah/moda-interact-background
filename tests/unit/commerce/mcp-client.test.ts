import { afterEach, describe, expect, it, vi } from "vitest";
import { CommerceHostError, CommerceMcpClient } from "../../../src/commerce/mcp-client.js";

const outreachTurn = {
  shopId: "shop-safe",
  toolContext: { purpose: "INITIAL_RECOVERY_OUTREACH" as const },
};

async function connectTo(response: Response): Promise<CommerceHostError> {
  vi.stubGlobal("fetch", vi.fn(async () => response));
  const client = new CommerceMcpClient(
    { endpoint: new URL("https://commerce.example/api/mcp") },
    outreachTurn,
    new AbortController().signal,
  );
  try {
    await client.connect();
  } catch (error) {
    if (error instanceof CommerceHostError) return error;
    throw error;
  }
  throw new Error("Expected the MCP transport to reject the response");
}

afterEach(() => vi.unstubAllGlobals());

describe("CommerceMcpClient HTTP source diagnostics", () => {
  it.each([
    [401, "UNAUTHENTICATED: assertion rejected", "DENIED", false],
    [503, "Commerce worker unavailable", "UNAVAILABLE", true],
  ] as const)("preserves the original HTTP %i error without changing host semantics", async (status, message, code, retryable) => {
    const error = await connectTo(new Response(JSON.stringify({ error: { code: `E${status}`, message } }), {
      status,
      headers: { "content-type": "application/json", "x-request-id": `request-${status}` },
    }));

    expect(error).toMatchObject({ code, retryable, sourceFailure: {
      origin: "mcp_response", provider: "commerce-mcp", operation: "initialize",
      httpStatus: status, providerRequestId: `request-${status}`,
      providerError: { code: `E${status}`, message }, redactionApplied: false, truncated: false,
    } });
  });

  it("preserves a non-JSON MCP error body and marks truncation", async () => {
    const error = await connectTo(new Response("MCP upstream rejected this request", {
      status: 502,
      headers: { "content-type": "text/plain" },
    }));
    expect(error.sourceFailure).toMatchObject({
      origin: "mcp_response", httpStatus: 502,
      providerErrorBody: "MCP upstream rejected this request", redactionApplied: false,
    });

    const truncated = await connectTo(new Response("x".repeat(10_000), { status: 502 }));
    expect(truncated.sourceFailure).toMatchObject({ truncated: true });
    expect(truncated.sourceFailure?.providerErrorBody).toHaveLength(1024 + "[TRUNCATED]".length);
  });

  it("redacts credentials, customer email and signed URLs before preserving source text", async () => {
    const error = await connectTo(new Response(JSON.stringify({
      error: { code: "AUTH_FAILED", message: "Bearer token-secret customer@example.com https://shop.example/object?signature=signed-secret" },
    }), { status: 401, headers: { "content-type": "application/json" } }));
    const serialized = JSON.stringify(error.sourceFailure);
    expect(error.sourceFailure).toMatchObject({
      providerError: { code: "AUTH_FAILED", message: "Bearer [REDACTED] [REDACTED] [REDACTED_URL]" },
      redactionApplied: true,
    });
    expect(serialized).not.toContain("token-secret");
    expect(serialized).not.toContain("customer@example.com");
    expect(serialized).not.toContain("signed-secret");
  });

  it("does not manufacture a providerError when the source has none", async () => {
    const emptyBody = await connectTo(new Response("{}", {
      status: 503,
      headers: { "content-type": "application/json" },
    }));
    expect(emptyBody.sourceFailure).toMatchObject({ httpStatus: 503, providerErrorBody: "{}" });
    expect(emptyBody.sourceFailure).not.toHaveProperty("providerError");

    const absentBody = await connectTo(new Response(null, { status: 503 }));
    expect(absentBody.sourceFailure).toMatchObject({ httpStatus: 503, redactionApplied: false });
    expect(absentBody.sourceFailure).not.toHaveProperty("providerError");
    expect(absentBody.sourceFailure).not.toHaveProperty("providerErrorBody");
  });

  it("preserves GraphQL error text and extension codes without retaining unrelated response fields", async () => {
    const error = await connectTo(new Response(JSON.stringify({
      errors: [{ message: "Shopify discount read denied", extensions: { code: "ACCESS_DENIED", trace: "discard-me" } }],
      data: { customer: { email: "customer@example.test" } },
    }), { status: 502, headers: { "content-type": "application/json" } }));
    expect(error.sourceFailure).toMatchObject({
      providerError: { details: [{ message: "Shopify discount read denied", extensions: { code: "ACCESS_DENIED" } }] },
      redactionApplied: true,
    });
    expect(JSON.stringify(error.sourceFailure)).not.toContain("discard-me");
    expect(JSON.stringify(error.sourceFailure)).not.toContain("customer@example.test");
  });

  it("does not invent an upstream message for malformed MCP success or caller cancellation", async () => {
    const malformed = await connectTo(new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    expect(malformed.code).toBe("UNAVAILABLE");
    expect(malformed.sourceFailure).toBeUndefined();

    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      controller.abort(new Error("caller stopped"));
      throw new Error("fetch aborted");
    }));
    const client = new CommerceMcpClient(
      { endpoint: new URL("https://commerce.example/api/mcp") },
      outreachTurn,
      controller.signal,
    );
    await expect(client.connect()).rejects.toMatchObject({ code: "CANCELLED" });
  });
});