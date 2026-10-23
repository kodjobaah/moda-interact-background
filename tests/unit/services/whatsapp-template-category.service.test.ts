import { beforeEach, describe, expect, it, vi } from "vitest";

const configuration = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../../src/services/platform-configuration/consumers.js", () => ({
  platformConsumerConfiguration: configuration,
}));
import { MetaWhatsAppTemplateCategoryService } from "../../../src/services/whatsapp-template-category.service.js";

const target = {
  providerAccountId: "987654321", providerTemplateName: "basket_reminder",
  providerLanguageCode: "en_GB", providerTemplateId: "template-123",
};
const row = { id: "template-123", name: "basket_reminder", language: "en_GB",
  status: "APPROVED", category: "MARKETING" };

function reader(data: unknown, ok = true) {
  const fetcher = vi.fn(async (_url: URL | string, _options: RequestInit) => ({ ok, json: async () => data }));
  return { service: new MetaWhatsAppTemplateCategoryService(fetcher as never), fetcher };
}

beforeEach(() => {
  vi.clearAllMocks();
  configuration.read.mockResolvedValue({ value: {
    businessAccountId: "987654321", accessToken: "secret-do-not-log",
  } });
});

describe("authoritative Meta recovery template Marketing category", () => {
  it("requires exact WABA, name, language, template ID and approved Marketing category", async () => {
    const { service, fetcher } = reader({ data: [row] });
    await expect(service.verify(target)).resolves.toBe("MARKETING");
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain("987654321/message_templates");
    expect(String(url)).toContain("name=basket_reminder");
    expect(new Headers(options.headers).get("Authorization")).toBe("Bearer secret-do-not-log");
  });
  it.each(["UTILITY", "AUTHENTICATION"])("returns the actual %s category rather than calling it Marketing", async (category) => {
    await expect(reader({ data: [{ ...row, category }] }).service.verify(target)).resolves.toBe(category);
  });
  it.each([
    { data: [{ ...row, status: "PENDING" }] },
    { data: [{ ...row, language: "fr_FR" }] },
    { data: [{ ...row, id: "unrelated-id" }] },
    { data: [row, row] },
    { data: [row], paging: { next: "https://other.example/page" } },
    { data: [{ ...row, category: "UNKNOWN" }] },
  ])("fails closed for unverified or ambiguous Meta metadata %#", async (data) => {
    await expect(reader(data).service.verify(target)).resolves.toBeNull();
  });
  it("fails closed for network errors and mismatched sender account", async () => {
    await expect(reader({ data: [row] }, false).service.verify(target)).resolves.toBeNull();
    await expect(reader({ data: [row] }).service.verify({ ...target, providerAccountId: "someone-else" }))
      .resolves.toBeNull();
    const service = new MetaWhatsAppTemplateCategoryService(vi.fn(async () => { throw new Error("offline"); }) as never);
    await expect(service.verify(target)).resolves.toBeNull();
  });
});
