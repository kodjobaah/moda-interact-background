import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? [path] : [];
  });
}

describe("shared onboarding authority", () => {
  it("does not read onboardingCompleted from legacy ShopSettings in production source", () => {
    const legacyRead = /\bsettings\s*\??\.\s*onboardingCompleted|\bsettings\s*:\s*\{[\s\S]{0,160}?\bonboardingCompleted\s*:/g;
    const matches = sourceFiles(join(process.cwd(), "src")).flatMap((path) => {
      const contents = readFileSync(path, "utf8");
      return [...contents.matchAll(legacyRead)].map(() => relative(process.cwd(), path));
    });

    expect(matches).toEqual([]);
  });
});
