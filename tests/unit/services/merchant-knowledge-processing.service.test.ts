import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MERCHANT_KNOWLEDGE_PROCESS_SCHEMA_VERSION } from "@modainteract/moda-interact-shared/merchant-knowledge";

import { MerchantKnowledgeAcquisitionError } from "../../../src/services/merchant-knowledge-web-page-acquirer.js";
import { MerchantKnowledgeProcessingService } from "../../../src/services/merchant-knowledge-processing.service.js";

type RevisionStatus = "PENDING" | "PROCESSING" | "ACTIVE" | "FAILED" | "SUPERSEDED";
type Format = { key: string; inputKind: "REMOTE_URL" | "UPLOAD" };

interface FixtureState {
  source: { id: string; shopId: string; currentGeneration: number; updatedAt: Date };
  revision: {
    id: string;
    sourceId: string;
    uploadedAssetId: string | null;
    generation: number;
    status: RevisionStatus;
    requestedUrl: string | null;
    failureCode: string | null;
    processingStartedAt: Date | null;
    contentType: string | null;
    resolvedUrl: string | null;
    normalizedContent: string | null;
    contentUnits: number | null;
    contentHash: string | null;
    truncated: boolean;
    completedAt: Date | null;
    fetchedAt: Date | null;
  };
  predecessor: {
    id: string;
    status: RevisionStatus;
    normalizedContent: string;
    completedAt: Date;
  };
  predecessorChunkCount: number;
  candidateChunkCount: number;
  dataFormat: Format;
}

const shopId = "shop-1";
const revisionId = "revision-1";
const generation = 4;
const job = {
  schemaVersion: MERCHANT_KNOWLEDGE_PROCESS_SCHEMA_VERSION,
  shopId,
  sourceRevisionId: revisionId,
  generation,
  requestedAt: "2026-10-01T00:00:00.000Z",
};

function eligible(maxContentUnitsPerSource = 20) {
  return {
    entitlement: {
      shopId,
      billingPlanId: "plan-1",
      maxKnowledgeSources: 5,
      maxContentUnitsPerSource,
      allowedSourceTypes: [{ purposeKey: "FAQ", dataFormatKey: "WEB_PAGE" }],
    },
    activationModeEligible: true,
    merchantEnabled: true,
    globallySupported: true,
    sourceTypeAllowed: true,
    withinSourceAllowance: true,
    eligible: true,
  };
}

function createFixture(options: {
  status?: RevisionStatus;
  sourceGeneration?: number;
  shopId?: string;
  inputKind?: "REMOTE_URL" | "UPLOAD";
  dataFormatKey?: string;
  requestedUrl?: string | null;
  uploadedAssetId?: string | null;
  extractedText?: string;
  maxContentUnits?: number;
  eligibilityResults?: ReturnType<typeof eligible>[];
  embed?: (content: string) => Promise<number[]>;
} = {}) {
  const state: FixtureState = {
    source: {
      id: "source-1",
      shopId: options.shopId ?? shopId,
      currentGeneration: options.sourceGeneration ?? generation,
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    },
    revision: {
      id: revisionId,
      sourceId: "source-1",
      uploadedAssetId: options.uploadedAssetId ?? null,
      generation,
      status: options.status ?? "PENDING",
      requestedUrl: options.requestedUrl === undefined
        ? "https://merchant.example/faq"
        : options.requestedUrl,
      failureCode: null,
      processingStartedAt: null,
      contentType: null,
      resolvedUrl: null,
      normalizedContent: null,
      contentUnits: null,
      contentHash: null,
      truncated: false,
      completedAt: null,
      fetchedAt: null,
    },
    predecessor: {
      id: "revision-old",
      status: "ACTIVE",
      normalizedContent: "retained predecessor content",
      completedAt: new Date("2026-09-30T00:00:00.000Z"),
    },
    predecessorChunkCount: 3,
    candidateChunkCount: 0,
    dataFormat: {
      key: options.dataFormatKey ?? "WEB_PAGE",
      inputKind: options.inputKind ?? "REMOTE_URL",
    },
  };
  const now = new Date("2026-10-01T01:00:00.000Z");
  const matchesStatus = (actual: RevisionStatus, expected: unknown) =>
    typeof expected === "string"
      ? actual === expected
      : Boolean(expected && "in" in expected && (expected as { in: string[] }).in.includes(actual));
  const sourceMatches = (where: { source?: { is?: { shopId?: string; currentGeneration?: number } } }) => {
    const expected = where.source?.is;
    return !expected || (
      (expected.shopId === undefined || expected.shopId === state.source.shopId)
      && (expected.currentGeneration === undefined
        || expected.currentGeneration === state.source.currentGeneration)
    );
  };
  const revisionUpdateMany = vi.fn(async (args: {
    where: { id: string; generation: number; status?: unknown; source?: { is?: { shopId?: string; currentGeneration?: number } } };
    data: Partial<FixtureState["revision"]>;
  }) => {
    if (
      args.where.id !== state.revision.id
      || args.where.generation !== state.revision.generation
      || !matchesStatus(state.revision.status, args.where.status)
      || !sourceMatches(args.where)
    ) return { count: 0 };
    Object.assign(state.revision, args.data);
    return { count: 1 };
  });
  const chunkDeleteMany = vi.fn(async (args: { where: { revisionId: string } }) => {
    if (args.where.revisionId === state.revision.id) state.candidateChunkCount = 0;
    if (args.where.revisionId === state.predecessor.id) state.predecessorChunkCount = 0;
    return { count: 0 };
  });
  const sourceUpdateMany = vi.fn(async (args: {
    where: { id: string; shopId: string; currentGeneration: number; updatedAt: Date };
  }) => ({
    count: args.where.id === state.source.id
      && args.where.shopId === state.source.shopId
      && args.where.currentGeneration === state.source.currentGeneration
      && args.where.updatedAt.getTime() === state.source.updatedAt.getTime()
      ? 1
      : 0,
  }));
  const transaction = {
    merchantKnowledgeSource: {
      findUnique: vi.fn(async () => ({ ...state.source })),
      updateMany: sourceUpdateMany,
    },
    merchantKnowledgeSourceRevision: {
      updateMany: revisionUpdateMany,
      findFirst: vi.fn(async (args: { where: { id?: string; status?: RevisionStatus } }) => {
        if (args.where.id === state.revision.id) {
          return state.revision.status === "PROCESSING" ? { id: state.revision.id } : null;
        }
        if (args.where.status === "ACTIVE" && state.predecessor.status === "ACTIVE") {
          return { id: state.predecessor.id };
        }
        return null;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        if (args.where.id === state.revision.id) Object.assign(state.revision, args.data);
        if (args.where.id === state.predecessor.id) Object.assign(state.predecessor, args.data);
        return { id: args.where.id };
      }),
    },
    merchantKnowledgeChunk: { deleteMany: chunkDeleteMany },
    $executeRaw: vi.fn(async () => {
      state.candidateChunkCount += 1;
      return 1;
    }),
  };
  const database = {
    merchantKnowledgeSource: transaction.merchantKnowledgeSource,
    merchantKnowledgeSourceRevision: {
      ...transaction.merchantKnowledgeSourceRevision,
      findUnique: vi.fn(async () => {
        if (options.status === "MISSING") return null;
        return {
          ...state.revision,
          source: {
            ...state.source,
            purpose: { key: "FAQ" },
            dataFormat: state.dataFormat,
          },
          uploadedAsset: state.revision.uploadedAssetId
            ? { id: state.revision.uploadedAssetId, shopId, dataFormat: { ...state.dataFormat } }
            : null,
        };
      }),
    },
    merchantKnowledgeChunk: transaction.merchantKnowledgeChunk,
    $transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) => operation(transaction)),
  };
  const webAcquire = vi.fn(async () => ({
    contentType: "text/html",
    extractedText: options.extractedText ?? "Merchant FAQ content",
    resolvedUrl: "https://merchant.example/faq",
    fetchedAt: now,
  }));
  const uploadAcquire = vi.fn(async () => ({
    contentType: "text/csv",
    extractedText: options.extractedText ?? "SKU,Name\nA,Widget",
    resolvedUrl: null,
    fetchedAt: null,
  }));
  const eligibilityResults = options.eligibilityResults ?? [eligible(options.maxContentUnits)];
  const resolveSourceEligibility = vi.fn(async () =>
    eligibilityResults.shift() ?? eligible(options.maxContentUnits),
  );
  const embed = options.embed ?? vi.fn(async () => [0.1, 0.2]);
  const logInfo = vi.fn();
  const service = new MerchantKnowledgeProcessingService({
    database: database as never,
    eligibility: { resolveSourceEligibility } as never,
    webPageAcquirer: { acquire: webAcquire },
    uploadedAssetAcquirer: { acquire: uploadAcquire },
    embedding: {
      config: { provider: "openai", model: "test-model", dimensions: 2, indexVersion: "v1" },
      embed,
    } as never,
    logger: { info: logInfo } as never,
    now: () => now,
  });

  return {
    service,
    state,
    database,
    transaction,
    webAcquire,
    uploadAcquire,
    resolveSourceEligibility,
    embed,
    logInfo,
  };
}

describe("MerchantKnowledgeProcessingService", () => {
  it("does not acquire for stale or missing job scope", async () => {
    const fixture = createFixture({ sourceGeneration: generation + 1 });
    await fixture.service.processJob(job);
    expect(fixture.webAcquire).not.toHaveBeenCalled();
    expect(fixture.resolveSourceEligibility).not.toHaveBeenCalled();
    expect(fixture.state.revision.status).toBe("PENDING");

    const wrongTenant = createFixture({ shopId: "another-shop" });
    await wrongTenant.service.processJob(job);
    expect(wrongTenant.webAcquire).not.toHaveBeenCalled();
    expect(wrongTenant.state.revision.status).toBe("PENDING");

    const missing = createFixture({ status: "MISSING" as RevisionStatus });
    await missing.service.processJob(job);
    expect(missing.logInfo).toHaveBeenCalledWith(
      "merchant_knowledge.revision.outcome",
      expect.objectContaining({ outcome: "REVISION_NOT_FOUND" }),
    );
  });

  it("leaves a dormant source PENDING without acquisition", async () => {
    const dormant = { ...eligible(), merchantEnabled: false, eligible: false };
    const fixture = createFixture({ eligibilityResults: [dormant] });
    await fixture.service.processJob(job);
    expect(fixture.state.revision.status).toBe("PENDING");
    expect(fixture.state.revision.processingStartedAt).toBeNull();
    expect(fixture.webAcquire).not.toHaveBeenCalled();
  });

  it("permanently fails a globally unsupported source", async () => {
    const unsupported = { ...eligible(), globallySupported: false, eligible: false };
    const fixture = createFixture({ eligibilityResults: [unsupported] });
    await fixture.service.processJob(job);
    expect(fixture.state.revision).toMatchObject({
      status: "FAILED",
      failureCode: "SOURCE_TYPE_UNSUPPORTED",
    });
    expect(fixture.webAcquire).not.toHaveBeenCalled();
    expect(fixture.state.predecessor.status).toBe("ACTIVE");
  });

  it("dispatches REMOTE_URL only to the WEB_PAGE acquirer", async () => {
    const fixture = createFixture();
    await fixture.service.processJob(job);
    expect(fixture.webAcquire).toHaveBeenCalledWith({
      requestedUrl: "https://merchant.example/faq",
    });
    expect(fixture.uploadAcquire).not.toHaveBeenCalled();
  });

  it.each(["CSV", "XLSX"] as const)(
    "dispatches %s UPLOAD input to the uploaded-asset acquirer",
    async (dataFormatKey) => {
      const fixture = createFixture({
        inputKind: "UPLOAD",
        dataFormatKey,
        requestedUrl: null,
        uploadedAssetId: "asset-1",
      });
      await fixture.service.processJob(job);
      expect(fixture.uploadAcquire).toHaveBeenCalledWith({
        shopId,
        assetId: "asset-1",
        dataFormatKey,
      });
      expect(fixture.webAcquire).not.toHaveBeenCalled();
    },
  );

  it("rejects a locator and format mismatch permanently", async () => {
    const fixture = createFixture({ requestedUrl: null });
    await fixture.service.processJob(job);
    expect(fixture.state.revision).toMatchObject({
      status: "FAILED",
      failureCode: "LOCATOR_FORMAT_MISMATCH",
    });
    expect(fixture.webAcquire).not.toHaveBeenCalled();
  });

  it("truncates by Unicode code point and hashes the final exact content", async () => {
    const fixture = createFixture({
      maxContentUnits: 1,
      extractedText: "\u{1f9ed}abcde",
    });
    await fixture.service.processJob(job);
    expect(fixture.state.revision.normalizedContent).toBe("\u{1f9ed}abc");
    expect(fixture.state.revision).toMatchObject({
      contentUnits: 1,
      truncated: true,
      contentHash: createHash("sha256").update("\u{1f9ed}abc", "utf8").digest("hex"),
      status: "ACTIVE",
    });
  });

  it("activates empty normalized content without calling embeddings", async () => {
    const fixture = createFixture({ extractedText: " \t\r\n " });
    await fixture.service.processJob(job);
    expect(fixture.state.revision).toMatchObject({
      status: "ACTIVE",
      normalizedContent: "",
      contentUnits: 0,
    });
    expect(fixture.embed).not.toHaveBeenCalled();
    expect(fixture.state.candidateChunkCount).toBe(0);
  });

  it("fails invalid embedding dimensions and preserves the active predecessor", async () => {
    const fixture = createFixture({ embed: vi.fn(async () => [0.1]) });
    await fixture.service.processJob(job);
    expect(fixture.state.revision).toMatchObject({
      status: "FAILED",
      failureCode: "EMBEDDING_VECTOR_INVALID",
    });
    expect(fixture.state.predecessor.status).toBe("ACTIVE");
    expect(fixture.state.predecessorChunkCount).toBe(3);
  });

  it.each(["dormant", "source-type downgrade", "limit changed"] as const)(
    "resets the current candidate to PENDING when eligibility becomes %s",
    async (change) => {
      const before = eligible(20);
      const after = change === "dormant"
        ? { ...eligible(20), merchantEnabled: false, eligible: false }
        : change === "source-type downgrade"
          ? { ...eligible(20), sourceTypeAllowed: false, eligible: false }
          : eligible(21);
      const fixture = createFixture({ eligibilityResults: [before, after] });
      await fixture.service.processJob(job);
      expect(fixture.state.revision.status).toBe("PENDING");
      expect(fixture.state.revision.processingStartedAt).toBeNull();
      expect(fixture.state.candidateChunkCount).toBe(0);
      expect(fixture.state.predecessor.status).toBe("ACTIVE");
    },
  );

  it("keeps the predecessor usable on transient acquisition failure", async () => {
    const fixture = createFixture();
    fixture.webAcquire.mockRejectedValueOnce(
      new MerchantKnowledgeAcquisitionError(
        "DNS_TEMPORARY_FAILURE",
        "Temporary DNS resolution failure.",
        true,
      ),
    );
    await expect(fixture.service.processJob(job)).rejects.toMatchObject({
      failureCode: "DNS_TEMPORARY",
      retryable: true,
    });
    expect(fixture.state.revision.status).toBe("PROCESSING");
    expect(fixture.state.predecessor.status).toBe("ACTIVE");
    expect(fixture.state.predecessorChunkCount).toBe(3);
  });

  it("rebuilds retry candidate chunks and safely supersedes the predecessor", async () => {
    const fixture = createFixture({ status: "PROCESSING" });
    fixture.state.candidateChunkCount = 2;
    await fixture.service.processJob(job);
    expect(fixture.transaction.merchantKnowledgeChunk.deleteMany)
      .toHaveBeenCalledWith({ where: { revisionId } });
    expect(fixture.state.candidateChunkCount).toBe(1);
    expect(fixture.state.predecessor.status).toBe("SUPERSEDED");
    expect(fixture.state.predecessor.normalizedContent).toBe("retained predecessor content");
    expect(fixture.state.predecessorChunkCount).toBe(0);
    expect(fixture.state.revision.status).toBe("ACTIVE");
  });

  it("terminalizes only the same current PROCESSING revision", async () => {
    const fixture = createFixture({ status: "PROCESSING" });
    await fixture.service.markTerminalFailure({ job, failureCode: "anything" });
    expect(fixture.state.revision).toMatchObject({
      status: "FAILED",
      failureCode: "RETRIES_EXHAUSTED",
    });

    const stale = createFixture({ status: "PROCESSING", sourceGeneration: generation + 1 });
    await stale.service.markTerminalFailure({ job, failureCode: "anything" });
    expect(stale.state.revision.status).toBe("PROCESSING");
  });
});