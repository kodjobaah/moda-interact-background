import { describe, expect, it } from "vitest";
import {
  canonicalizeRecoveryRecipient,
  isCanonicalRecoveryRecipient,
} from "../../../../src/services/checkout-recovery/recovery-recipient-canonicalization.js";

describe("recovery recipient canonicalization", () => {
  it.each([
    ["447400123456", "447400123456"],
    ["+44 7400-123456", "447400123456"],
    ["+1 (415) 555-0123", "14155550123"],
    ["123456789012345", "123456789012345"],
  ])("canonicalizes %s without inferring a country", (input, expected) => {
    expect(canonicalizeRecoveryRecipient(input)).toBe(expected);
    expect(isCanonicalRecoveryRecipient(expected)).toBe(true);
  });

  it.each([
    null,
    undefined,
    "",
    "0",
    "0123456789",
    "1",
    "1234567890123456",
    "abc447400123456",
    "+44+7400123456",
    "+44/7400123456",
    "44\n7400123456",
  ])("rejects invalid international syntax %s", (input) => {
    expect(canonicalizeRecoveryRecipient(input)).toBeNull();
    expect(isCanonicalRecoveryRecipient(input)).toBe(false);
  });

  it.each(["+447400123456", "44 7400 123456", " 447400123456 "])(
    "requires exact canonical storage syntax %s",
    (input) => {
      expect(isCanonicalRecoveryRecipient(input)).toBe(false);
    },
  );
});
