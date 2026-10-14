import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCommerceCredentialKeyring } from "../../../src/commerce/credential-keyring.js";

const secret = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", JSON.stringify({ active: secret })));
afterEach(() => vi.unstubAllEnvs());

describe("readCommerceCredentialKeyring (Shared parser)", () => {
  it("accepts canonical 32-byte Base64 keys without exposing secret bytes", () => {
    const keyring = readCommerceCredentialKeyring();
    expect(keyring.keyIds).toEqual(["active"]);
    expect(keyring.hasKey("active")).toBe(true);
    expect(Object.keys(keyring)).not.toContain("active");
  });

  it("accepts valid key ids through the 64-character limit", () => {
    const id = "k".repeat(64);
    vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", JSON.stringify({ [id]: secret }));
    expect(readCommerceCredentialKeyring().hasKey(id)).toBe(true);
  });

  it.each([
    ["missing configuration", undefined],
    ["malformed JSON", "{"],
    ["an array", "[]"],
    ["a scalar", '"value"'],
    ["a blank key id", JSON.stringify({ "  ": secret })],
    ["an overlong key id", JSON.stringify({ ["k".repeat(65)]: secret })],
    ["invalid base64", JSON.stringify({ active: "not base64!" })],
    ["a short key", JSON.stringify({ active: Buffer.alloc(16).toString("base64") })],
    ["an empty keyring", "{}"],
    ["duplicate key ids", `{"active":"${secret}","active":"${secret}"}`],
    ["escaped duplicate key ids", `{"active":"${secret}","a\\u0063tive":"${secret}"}`],
  ])("rejects %s with a bounded error", (_label, value) => {
    vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", value);
    expect(() => readCommerceCredentialKeyring()).toThrow("Commerce credential keyring is invalid");
  });

  it("never falls back to service-specific keyring variables", () => {
    vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", undefined);
    vi.stubEnv("MODA_WOO_REST_READ_KEYRING", JSON.stringify({ active: secret }));
    expect(() => readCommerceCredentialKeyring()).toThrow("Commerce credential keyring is invalid");
  });

  it("does not expose key material in errors or console output", () => {
    vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", JSON.stringify({ active: "bad-secret-material" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => readCommerceCredentialKeyring()).toThrow("Commerce credential keyring is invalid");
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
