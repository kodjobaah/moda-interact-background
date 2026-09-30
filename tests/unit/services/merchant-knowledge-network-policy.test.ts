import { describe, expect, it, vi } from "vitest";

import {
  createPinnedLookup,
  isPublicIpAddress,
  resolveAndValidateDestination,
} from "../../../src/services/merchant-knowledge-network-policy.js";

describe("Merchant Knowledge network policy", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.2.1",
    "192.31.196.1",
    "192.52.193.1",
    "192.168.1.1",
    "192.175.48.1",
    "198.18.0.1",
    "198.19.255.254",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "2001:db8::1",
    "2001:20::1",
    "fc00::1",
    "fe80::1",
    "4000::1",
    "6000::1",
    "fe00::1",
    "ff02::1",
    "64:ff9b::808:808",
    "2002::1",
    "3fff::1",
    "::ffff:127.0.0.1",
  ])("rejects non-global address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ])(
    "accepts global unicast address %s",
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );

  it("rejects a hostname when any DNS answer is denied", async () => {
    await expect(
      resolveAndValidateDestination("mixed.example", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toMatchObject({ code: "DENIED_DESTINATION", retryable: false });
  });

  it("requires DNS answers and distinguishes temporary resolution failures", async () => {
    await expect(
      resolveAndValidateDestination("empty.example", async () => []),
    ).rejects.toMatchObject({ code: "DNS_NO_ADDRESSES" });
    await expect(
      resolveAndValidateDestination("retry.example", async () => {
        throw Object.assign(new Error("dns"), { code: "EAI_AGAIN" });
      }),
    ).rejects.toMatchObject({ code: "DNS_TEMPORARY_FAILURE", retryable: true });
  });

  it("sorts validated answers by family and lexical address and binds lookup", async () => {
    const resolver = vi.fn(async () => [
      { address: "2606:4700:4700::1111", family: 6 as const },
      { address: "8.8.4.4", family: 4 as const },
      { address: "1.1.1.1", family: 4 as const },
    ]);
    const selected = await resolveAndValidateDestination("example.com", resolver);
    expect(selected).toEqual({ address: "1.1.1.1", family: 4 });
    expect(resolver).toHaveBeenCalledWith("example.com");

    const lookup = createPinnedLookup(selected);
    const result = await new Promise((resolve, reject) => {
      lookup("example.com", { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    });
    expect(result).toEqual([{ address: "1.1.1.1", family: 4 }]);
  });

  it("validates IP literals directly without DNS", async () => {
    const resolver = vi.fn();
    await expect(
      resolveAndValidateDestination("8.8.8.8", resolver),
    ).resolves.toEqual({ address: "8.8.8.8", family: 4 });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("uses lexical address order for IPv6 answers after family ordering", async () => {
    await expect(
      resolveAndValidateDestination("ipv6.example", async () => [
        { address: "2001:4860::1", family: 6 },
        { address: "2001:4860:1::1", family: 6 },
      ]),
    ).resolves.toEqual({ address: "2001:4860:1::1", family: 6 });
  });
});