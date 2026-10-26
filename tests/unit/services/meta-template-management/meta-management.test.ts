import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetaTemplateManagementService } from "../../../../src/services/meta-template-management/service.js";
import { MetaManagementError, validatedComponents } from "../../../../src/services/meta-template-management/contracts.js";
import { MetaGraphTemplateAdapter } from "../../../../src/services/meta-template-management/meta-graph.adapter.js";

vi.mock("../../../../src/services/platform-configuration/consumers.js", () => ({
  platformConsumerConfiguration: { read: vi.fn(async () => ({ value: {
    accessToken: "test-only-token", businessAccountId: "123456", phoneNumberId: "999999",
  } })) },
}));

const now = new Date("2026-10-25T10:00:00Z");
const compiled = [{ type: "BODY", text: "Recover your basket {{1}}", example: { body_text: [["Ada"]] } }];
const record = {
  id: "reg-1", wabaId: "123456", providerTemplateName: "moda_recovery_a1",
  providerLanguageCode: "en", category: "MARKETING",
  componentsSnapshot: compiled, submittedContentHash: "a".repeat(64),
  providerTemplateId: null, submissionState: "READY_TO_SUBMIT", updatedAt: now,
  lastSubmittedAt: null,
};
const claim = {
  registrationId: "reg-1", localeId: "locale-1", wabaId: "123456",
  name: "moda_recovery_a1", language: "en", category: "MARKETING" as const,
  components: compiled, contentHash: "a".repeat(64),
  updatedAt: now, submittedAt: now, providerId: null, submissionState: "SUBMITTING",
};
function fixture() {
  const repository = {
    load: vi.fn(async () => record), claim: vi.fn(async () => claim),
    finishSubmission: vi.fn(async () => true), recordPostIntent: vi.fn(async () => {}),
    blockReadyRegistration: vi.fn(async () => true), listDue: vi.fn(async () => []),
    recordObservation: vi.fn(async () => ({ duplicate: false, registrationId: "reg-1" })),
    recordReconciliation: vi.fn(async () => true),
  };
  const provider = {
    verifyWaba: vi.fn(async () => {}),
    find: vi.fn(async () => ({ kind: "absent" as const })),
    create: vi.fn(async (_input: unknown) => ({ id: "meta-1" })),
  };
  const reporting = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new MetaTemplateManagementService(repository as never, provider, reporting as never);
  return { service, repository, provider, reporting };
}

describe("BG003 Meta template management", () => {
  beforeEach(() => vi.clearAllMocks());

  it("submits the frozen Admin-compiled components unchanged using create only", async () => {
    const { service, provider, repository } = fixture();
    await expect(service.submitPreparedRegistration("reg-1"))
      .resolves.toEqual({ kind: "submitted", providerId: "meta-1" });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(repository.recordPostIntent).toHaveBeenCalledWith(claim);
    expect(repository.recordPostIntent.mock.invocationCallOrder[0]!).toBeLessThan(provider.create.mock.invocationCallOrder[0]!);
    expect(provider.create).toHaveBeenCalledWith({ ...claim });
    const posted = provider.create.mock.calls[0]?.[0] as { components: unknown } | undefined;
    expect(posted?.components).toBe(compiled);
    expect(repository.finishSubmission).toHaveBeenCalledWith(claim, { kind: "submitted", providerId: "meta-1" });
  });

  it("does not POST twice for a provider-confirmed registration", async () => {
    const f = fixture();
    f.repository.load.mockResolvedValueOnce({ ...record, submissionState: "SUBMITTED", providerTemplateId: "meta-1" } as never);
    await expect(f.service.submitPreparedRegistration("reg-1"))
      .resolves.toEqual({ kind: "already-submitted", providerId: "meta-1" });
    expect(f.provider.create).not.toHaveBeenCalled();
  });

  it("never adopts an external name collision on a new Admin registration", async () => {
    const f = fixture();
    f.provider.find.mockResolvedValueOnce({ kind: "found", template: {
      ...claim, id: "external", status: "APPROVED", category: "MARKETING", components: compiled,
    } } as never);
    await expect(f.service.submitPreparedRegistration("reg-1"))
      .resolves.toEqual({ kind: "blocked", code: "PROVIDER_NAME_COLLISION" });
    expect(f.provider.create).not.toHaveBeenCalled();
    expect(f.repository.recordPostIntent).not.toHaveBeenCalled();
    expect(f.repository.finishSubmission).toHaveBeenCalledWith(claim, { kind: "blocked", code: "PROVIDER_NAME_COLLISION" });
  });

  it("logs and propagates uncertain POST failures; marks intent UNKNOWN before retry", async () => {
    const f = fixture();
    const error = new MetaManagementError("META_TRANSPORT_UNKNOWN", "uncertain");
    f.provider.create.mockRejectedValueOnce(error);
    await expect(f.service.submitPreparedRegistration("reg-1")).rejects.toBe(error);
    expect(f.repository.finishSubmission).toHaveBeenCalledWith(claim,
      { kind: "unknown", code: "META_TRANSPORT_UNKNOWN" });
    expect(f.reporting.error).toHaveBeenCalledWith("meta.template.create.error", expect.objectContaining({
      registrationId: "reg-1", code: "META_TRANSPORT_UNKNOWN",
    }));
  });

  it("never repeats unknown creates; uses provider GET to reconcile instead", async () => {
    const f = fixture();
    f.repository.load.mockResolvedValueOnce({ ...record, submissionState: "SUBMISSION_UNKNOWN" } as never);
    f.repository.load.mockResolvedValueOnce({ ...record, submissionState: "SUBMISSION_UNKNOWN" } as never);
    f.repository.load.mockResolvedValueOnce({ ...record, submissionState: "SUBMITTED", providerTemplateId: "meta-1" } as never);
    f.provider.find.mockResolvedValueOnce({ kind: "found", template: {
      ...claim, id: "meta-1", status: "APPROVED", category: "MARKETING", components: compiled,
    } } as never);
    await expect(f.service.submitPreparedRegistration("reg-1"))
      .resolves.toEqual({ kind: "already-submitted", providerId: "meta-1" });
    expect(f.provider.create).not.toHaveBeenCalled();
    expect(f.repository.recordReconciliation).toHaveBeenCalledTimes(1);
  });

  it("logs compensation failures and preserves both exceptions and original cause", async () => {
    const f = fixture();
    const original = new Error("test provider fault");
    const persistence = new Error("test database fault");
    f.provider.create.mockRejectedValueOnce(original);
    f.repository.finishSubmission.mockRejectedValueOnce(persistence);
    const failure = await f.service.submitPreparedRegistration("reg-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(original);
    expect((failure as AggregateError).errors).toEqual([original, persistence]);
    expect(f.reporting.error).toHaveBeenCalledWith("meta.template.create.compensation_failed", expect.anything());
  });

  it("surfaces lost compensation CAS instead of silently acknowledging an unknown submission", async () => {
    const f = fixture();
    const original = new Error("provider outcome unknown");
    f.provider.create.mockRejectedValueOnce(original);
    f.repository.finishSubmission.mockResolvedValueOnce(false);
    const result = await f.service.submitPreparedRegistration("reg-1").catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).cause).toBe(original);
    expect((result as AggregateError).errors).toEqual([original, expect.objectContaining({ code: "CREATE_FAILURE_CAS_LOST" })]);
    expect(f.reporting.error).toHaveBeenCalledWith("meta.template.create.compensation_failed", expect.anything());
  });

  it("persists blocked image-header submission without calling Meta", async () => {
    const f = fixture();
    f.repository.load.mockResolvedValueOnce({ ...record, componentsSnapshot: [{ type: "HEADER",
      format: "IMAGE", example: { header_handle: ["https://merchant.example/original.png"] } }] } as never);
    await expect(f.service.submitPreparedRegistration("reg-1"))
      .resolves.toEqual({ kind: "blocked", code: "IMAGE_SAMPLE_HANDLE_REQUIRED" });
    expect(f.repository.blockReadyRegistration).toHaveBeenCalledWith("reg-1", "IMAGE_SAMPLE_HANDLE_REQUIRED");
    expect(f.provider.create).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid IMAGE submission handle, but permits text URLs", () => {
    expect(() => validatedComponents([{ type: "HEADER", format: "IMAGE", example: {
      header_handle: ["https://merchant.example/image.png"],
    } }])).toThrowError("IMAGE_SAMPLE_HANDLE_REQUIRED");
    expect(() => validatedComponents([{ type: "HEADER", format: "IMAGE" }])).toThrowError("IMAGE_SAMPLE_HANDLE_REQUIRED");
    expect(() => validatedComponents([{ type: "HEADER", format: "IMAGE", example: {
      header_handle: ["data:image/png;base64,abc"],
    } }])).toThrowError("IMAGE_SAMPLE_HANDLE_REQUIRED");
    expect(validatedComponents([{ type: "HEADER", format: "IMAGE", example: { header_handle: ["4::opaque-sample-handle"] } }])).toHaveLength(1);
    expect(validatedComponents([{ type: "BODY", text: "See https://merchant.example/logo" }])).toHaveLength(1);
  });

  it("handles duplicate and unmatched authenticated observations without adopting templates", async () => {
    const f = fixture();
    const event = { eventIdentity: "event-1", wabaId: "123456", providerTemplateName: "moda_recovery_a1",
      providerLanguageCode: "en", providerStatus: "APPROVED", occurredAt: now.toISOString() };
    f.repository.recordObservation.mockResolvedValueOnce({ duplicate: true, registrationId: null } as never);
    await expect(f.service.processTemplateStatusObservation(event)).resolves.toBe("duplicate");
    f.repository.recordObservation.mockResolvedValueOnce({ duplicate: false, registrationId: null } as never);
    await expect(f.service.processTemplateStatusObservation({ ...event, eventIdentity: "event-2" })).resolves.toBe("unmatched");
    expect(f.provider.find).not.toHaveBeenCalled();
  });

  it("a repeated linked event retries GET after failure between receipt and reconciliation", async () => {
    const f = fixture();
    f.repository.recordObservation.mockResolvedValueOnce({ duplicate: true, registrationId: "reg-1" });
    f.repository.load.mockResolvedValueOnce({ ...record, submissionState: "SUBMITTED", providerTemplateId: "meta-1" } as never);
    f.provider.find.mockResolvedValueOnce({ kind: "found", template: {
      ...claim, id: "meta-1", status: "PAUSED", category: "MARKETING", components: compiled,
    } } as never);
    await expect(f.service.processTemplateStatusObservation({
      eventIdentity: "event-duplicate", wabaId: "123456", providerTemplateName: "moda_recovery_a1",
      providerLanguageCode: "en", providerStatus: "APPROVED", occurredAt: now.toISOString(),
    })).resolves.toBe("current");
    expect(f.provider.find).toHaveBeenCalledTimes(1);
  });

  it("reordered webhook APPROVED uses fresh Meta GET, not the stale webhook label", async () => {
    const f = fixture();
    f.repository.load.mockResolvedValueOnce({ ...record, submissionState: "SUBMITTED", providerTemplateId: "meta-1" } as never);
    f.provider.find.mockResolvedValueOnce({ kind: "found", template: {
      ...claim, id: "meta-1", status: "PAUSED", category: "MARKETING", components: compiled,
    } } as never);
    const result = await f.service.processTemplateStatusObservation({
      eventIdentity: "event-3", wabaId: "123456", providerTemplateName: "moda_recovery_a1",
      providerLanguageCode: "en", providerStatus: "APPROVED", occurredAt: now.toISOString(),
    });
    expect(result).toBe("current");
    expect(f.repository.recordReconciliation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "PAUSED", drift: false,
    }));
  });

  it("detects category/content drift and never activates any shop", async () => {
    const f = fixture();
    f.repository.load.mockResolvedValueOnce({ ...record, submissionState: "SUBMITTED", providerTemplateId: "meta-1" } as never);
    f.provider.find.mockResolvedValueOnce({ kind: "found", template: {
      ...claim, id: "meta-1", status: "APPROVED", category: "UTILITY",
      components: [{ type: "BODY", text: "Provider modified this" }],
    } } as never);
    expect(await f.service.reconcileRegistration("reg-1")).toEqual({ kind: "drift", status: "APPROVED" });
    expect(f.repository.recordReconciliation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ drift: true }));
  });
});

describe("BG003 server-side Meta Graph API adapter", () => {
  it("POSTs only to the WABA create endpoint, preserves compiled components and uses a private token", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ id: "meta-1" }), { status: 200 }));
    const client = new MetaGraphTemplateAdapter(request as typeof fetch);
    await expect(client.create(claim)).resolves.toEqual({ id: "meta-1" });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toMatch(/\/123456\/message_templates$/);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(expect.objectContaining({ Authorization: "Bearer test-only-token" }));
    expect(JSON.parse(init.body as string)).toEqual({
      name: claim.name, language: claim.language, category: claim.category, components: compiled,
    });
    expect(JSON.stringify(init.body)).not.toContain("template-id");
  });

  it("never calls the network for a different WABA", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ id: "meta-1" })));
    const client = new MetaGraphTemplateAdapter(request as typeof fetch);
    await expect(client.create({ ...claim, wabaId: "987654" })).rejects.toMatchObject({ code: "WABA_MISMATCH" });
    expect(request).not.toHaveBeenCalled();
  });

  it("does not trust a truncated Meta template-list response", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [], paging: { next: "other-page" } })));
    const client = new MetaGraphTemplateAdapter(request as typeof fetch);
    await expect(client.find(claim)).rejects.toMatchObject({ code: "META_LIST_INCOMPLETE" });
  });

  it("classifies rate-limit/timeout responses without logging provider bodies or secrets", async () => {
    const client = new MetaGraphTemplateAdapter(vi.fn(async () => new Response("secret", { status: 429 })) as typeof fetch);
    await expect(client.create(claim)).rejects.toMatchObject({ code: "META_RATE_LIMIT", disposition: "uncertain" });
  });

  it("reads paginated Meta template listings without external paging requests", async () => {
    const request = vi.fn(async (url: URL) => {
      if (!url.searchParams.get("after")) {
        const next = new URL(url.toString());
        next.searchParams.set("after", "opaque-cursor-2");
        return new Response(JSON.stringify({ data: [], paging: { next: next.toString() } }));
      }
      return new Response(JSON.stringify({ data: [{
        id: "987654321", name: claim.name, language: claim.language,
        status: "APPROVED", category: "MARKETING", components: compiled,
      }] }));
    });
    const client = new MetaGraphTemplateAdapter(request as unknown as typeof fetch);
    await expect(client.find(claim)).resolves.toMatchObject({ kind: "found", template: { id: "987654321" } });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![0].origin).toBe(request.mock.calls[0]![0].origin);
  });

  it("rejects cross-origin provider pagination rather than following arbitrary URLs", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: [], paging: { next: "https://untrusted.example/steal?after=token" },
    })));
    const client = new MetaGraphTemplateAdapter(request as typeof fetch);
    await expect(client.find(claim)).rejects.toMatchObject({ code: "META_LIST_INCOMPLETE" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not treat a full unpaginated result page as proof of provider absence", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: Array.from({ length: 100 }, (_, index) => ({ name: `other_${index}` })),
    })));
    const client = new MetaGraphTemplateAdapter(request as typeof fetch);
    await expect(client.find(claim)).rejects.toMatchObject({ code: "META_LIST_INCOMPLETE" });
  });

});
