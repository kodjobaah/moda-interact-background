import { describe, expect, it } from "vitest";

import {
  resolveOutboundLimits,
  validateTerminalMessageReservedSlots,
} from "../../../src/services/billing-policy/outbound-limits.js";

type Override = {
  outboundSoftLimit: number | null;
  outboundHardLimit: number | null;
} | null;

const invalidConfiguration = (shopId: string, detail: string): Error =>
  new Error(`Invalid policy for shop ${shopId}: ${detail}`);

function resolve(
  platformSoft: number,
  platformHard: number,
  absoluteHard: number,
  override: Override = null,
) {
  return resolveOutboundLimits(
    "shop-1",
    platformSoft,
    platformHard,
    absoluteHard,
    override,
    invalidConfiguration,
  );
}

describe("shared outbound-limit policy", () => {
  it.each([
    {
      title: "caps the default hard limit without changing the default soft limit",
      override: null,
      expected: { soft: 10, hard: 15 },
    },
    {
      title: "uses an active hard override and bounds the inherited soft limit",
      override: { outboundSoftLimit: null, outboundHardLimit: 8 },
      expected: { soft: 8, hard: 8 },
    },
    {
      title: "uses independent shop soft and hard overrides",
      override: { outboundSoftLimit: 7, outboundHardLimit: 9 },
      expected: { soft: 7, hard: 9 },
    },
    {
      title: "caps both requested shop limits by the absolute hard ceiling",
      override: { outboundSoftLimit: 18, outboundHardLimit: 100 },
      expected: { soft: 15, hard: 15 },
    },
    {
      title: "uses a soft-only shop override",
      override: { outboundSoftLimit: 4, outboundHardLimit: null },
      expected: { soft: 4, hard: 15 },
    },
  ])("$title", ({ override, expected }) => {
    expect(resolve(10, 20, 15, override)).toEqual(expected);
  });

  it.each([
    {
      title: "platform soft minimum",
      limits: [0, 20, 15] as const,
      override: null,
      detail: "platform soft limit must be a finite integer of at least 1",
    },
    {
      title: "unsafe platform soft integer",
      limits: [Number.MAX_SAFE_INTEGER + 1, 20, 15] as const,
      override: null,
      detail: "platform soft limit must be a finite integer of at least 1",
    },
    {
      title: "platform default hard minimum",
      limits: [1, 1, 15] as const,
      override: null,
      detail: "platform default hard limit must be a finite integer of at least 2",
    },
    {
      title: "absolute hard minimum",
      limits: [1, 20, Number.NaN] as const,
      override: null,
      detail: "platform absolute hard limit must be a finite integer of at least 2",
    },
    {
      title: "platform soft larger than platform default hard",
      limits: [21, 20, 30] as const,
      override: null,
      detail: "platform soft limit exceeds platform hard limit",
    },
    {
      title: "shop hard minimum",
      limits: [10, 20, 15] as const,
      override: { outboundSoftLimit: null, outboundHardLimit: 1 },
      detail: "shop hard limit must be a finite integer of at least 2",
    },
    {
      title: "shop soft minimum",
      limits: [10, 20, 15] as const,
      override: { outboundSoftLimit: 0, outboundHardLimit: null },
      detail: "shop soft limit must be a finite integer of at least 1",
    },
    {
      title: "shop soft larger than shop hard",
      limits: [10, 20, 15] as const,
      override: { outboundSoftLimit: 9, outboundHardLimit: 8 },
      detail: "shop soft limit exceeds shop hard limit",
    },
  ])("rejects $title with the original detail", ({ limits, override, detail }) => {
    expect(() => resolve(...limits, override)).toThrow(
      `Invalid policy for shop shop-1: ${detail}`,
    );
  });

  it("accepts reserved slots below the effective hard limit", () => {
    expect(validateTerminalMessageReservedSlots("shop-1", 14, 15, invalidConfiguration))
      .toBe(14);
  });

  it.each([0, -1, 15, 16, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid reserved slots %s",
    (value) => {
      expect(() => validateTerminalMessageReservedSlots(
        "shop-1", value, 15, invalidConfiguration,
      )).toThrow(
        "Invalid policy for shop shop-1: terminalMessageReservedSlots must be at least 1 and less than the effective hard limit",
      );
    },
  );
});
