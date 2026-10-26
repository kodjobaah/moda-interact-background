import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const moduleRoot = new URL("../../../../src/services/recovery-template-preparation/", import.meta.url);

describe("ARCH-047 BG001 module-only boundaries", () => {
  it("has no Meta API reads/writes, sends, billing or queue writes", () => {
    const sources = readdirSync(moduleRoot).filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(new URL(name, moduleRoot), "utf8")).join("\n");
    expect(sources).not.toMatch(/(?:\bfetch\s*\(|\.sendWhatsApp(?:Template|Text)\s*\(|\.add\s*\(|\.reserveCredit\s*\()/);
    expect(sources).not.toMatch(/(?:\.message_templates\b|graph\.facebook\.com|openai\.com|\.applyCoupon\s*\()/);
    expect(sources).toContain("@modainteract/moda-interact-shared/logging");
    expect(sources).not.toContain("console.error");
  });
});
