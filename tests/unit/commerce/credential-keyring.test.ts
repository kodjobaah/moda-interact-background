import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../src/services/platform-configuration/consumers.js", async () => {
  const { parseCredentialKeyring } = await import("@modainteract/moda-interact-shared/security/credentials/node");
  return { readCommerceKeyring: async () => parseCredentialKeyring(process.env.COMMERCE_CONNECTION_KEYS_JSON) };
});
import { readCanonicalCredentialKeyring as readCommerceCredentialKeyring } from "../../../src/commerce/credential-keyring.js";

const secret = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", JSON.stringify({ active: secret })));
afterEach(() => vi.unstubAllEnvs());

describe("readCommerceCredentialKeyring (Shared parser)", () => {
  it("accepts canonical 32-byte Base64 keys without exposing secret bytes", async () => {
    const keyring = await readCommerceCredentialKeyring();
    expect(keyring.keyIds).toEqual(["active"]);
    expect(keyring.hasKey("active")).toBe(true);
    expect(Object.keys(keyring)).not.toContain("active");
  });

  it("accepts valid key ids through the 64-character limit", async () => {
    const id = "k".repeat(64);
    vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", JSON.stringify({ [id]: secret }));
    expect((await readCommerceCredentialKeyring()).hasKey(id)).toBe(true);
  });

  it.each([
    ["missing configuration", undefined],
    ["malformed JSON", "{"],
    ["an array", "[]"],
    ["a scalar", '"value"'],
    ["a blank key id", JSON.stringify({ "  ": secret })],
    ["an overlong key id", JSON.stringify({ ["k".repeat(65)]: secret })],
    ["the former 128-character key ID", JSON.stringify({ ["k".repeat(128)]: secret })],
    ["invalid base64", JSON.stringify({ active: "not base64!" })],
    ["a short key", JSON.stringify({ active: Buffer.alloc(16).toString("base64") })],
    ["an empty keyring", "{}"],
    ["duplicate key ids", `{"active":"${secret}","active":"${secret}"}`],
    ["escaped duplicate key ids", `{"active":"${secret}","a\\u0063tive":"${secret}"}`],
  ])("rejects %s with a bounded error", async (_label, value) => {
    vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", value);
    await expect(readCommerceCredentialKeyring()).rejects.toThrow("Commerce credential keyring is invalid");
  });

  it("never falls back to service-specific keyring variables", async () => {
    vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", undefined);
    vi.stubEnv("MODA_WOO_REST_READ_KEYRING", JSON.stringify({ active: secret }));
    await expect(readCommerceCredentialKeyring()).rejects.toThrow("Commerce credential keyring is invalid");
  });

  it("does not expose key material in errors or console output", async () => {
    vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", JSON.stringify({ active: "bad-secret-material" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(readCommerceCredentialKeyring()).rejects.toThrow("Commerce credential keyring is invalid");
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
