import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCommerceCredentialKeyring } from "../../../src/commerce/credential-keyring.js";

const secret = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", JSON.stringify({ active: secret })));
afterEach(() => vi.unstubAllEnvs());

describe("readCommerceCredentialKeyring", () => {
  it("accepts 32-byte base64 keys", () => {
    const keyring = readCommerceCredentialKeyring();
    expect(Object.keys(keyring)).toEqual(["active"]);
    expect(keyring.active).toEqual(Buffer.alloc(32, 7));
  });

  it.each([
    ["malformed JSON", "{"],
    ["an array", "[]"],
    ["a scalar", "\"value\""],
    ["a blank key id", JSON.stringify({ "  ": secret })],
    ["invalid base64", JSON.stringify({ active: "not base64!" })],
    ["a short key", JSON.stringify({ active: Buffer.alloc(16).toString("base64") })],
    ["an empty keyring", "{}"],
  ])("rejects %s with a bounded error", (_label, value) => {
    vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", value);
    expect(() => readCommerceCredentialKeyring()).toThrow(
      "Commerce credential keyring is invalid",
    );
  });

  it("does not expose key material in errors or console output", () => {
    vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", JSON.stringify({ active: "bad-secret-material" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let message = "";
    try {
      readCommerceCredentialKeyring();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Commerce credential keyring is invalid");
    expect(message).not.toContain("bad-secret-material");
    expect(log).not.toHaveBeenCalled();
  });
});