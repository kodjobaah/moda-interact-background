import { describe, expect, it } from "vitest";

import { canApplyProviderStatus } from "../../../src/domain/whatsapp-provider-status-transition.js";

const transitions = [
  ["PENDING", "PENDING", true],
  ["PENDING", "SENT", true],
  ["PENDING", "DELIVERED", true],
  ["PENDING", "READ", true],
  ["PENDING", "FAILED", true],
  ["SENT", "PENDING", false],
  ["SENT", "SENT", true],
  ["SENT", "DELIVERED", true],
  ["SENT", "READ", true],
  ["SENT", "FAILED", true],
  ["FAILED", "PENDING", false],
  ["FAILED", "SENT", false],
  ["FAILED", "DELIVERED", true],
  ["FAILED", "READ", true],
  ["FAILED", "FAILED", true],
  ["DELIVERED", "PENDING", false],
  ["DELIVERED", "SENT", false],
  ["DELIVERED", "DELIVERED", true],
  ["DELIVERED", "READ", true],
  ["DELIVERED", "FAILED", false],
  ["READ", "PENDING", false],
  ["READ", "SENT", false],
  ["READ", "DELIVERED", false],
  ["READ", "READ", true],
  ["READ", "FAILED", false],
] as const;

describe("WhatsApp provider status transitions", () => {
  it.each(transitions)("%s -> %s is allowed: %s", (current, event, allowed) => {
    expect(canApplyProviderStatus(current, event)).toBe(allowed);
  });
});