import {
  canonicalJson,
  CommerceToolOutputs,
  CommerceEvidenceSchema,
  type CommerceTurnIdentity,
  type CommerceEvidence,
  type CommerceToolResult,
} from "@modainteract/moda-interact-shared/commerce";
import { createHash } from "node:crypto";
import { metrics, type Counter } from "@opentelemetry/api";

export type EvidenceExtractor = (
  result: CommerceToolResult,
) => unknown[];

export type EvidenceRefreshOutcome =
  | { kind: "accepted" }
  | { kind: "refer" }
  | { kind: "suppress"; reason: "STALE_TURN" | "CANCELLED" };

const refreshOutcomes: Counter = (() => {
  try {
    return metrics
      .getMeter("moda-interact-background.commerce")
      .createCounter("moda.background.commerce.evidence.refresh", {
        description: "Commerce offer evidence refresh outcomes",
        unit: "1",
      });
  } catch {
    return { add() {} };
  }
})();

export function recordEvidenceRefreshOutcome(outcome: EvidenceRefreshOutcome) {
  try {
    refreshOutcomes.add(1, {
      "moda.commerce.evidence.outcome": outcome.kind,
      ...(outcome.kind === "suppress"
        ? { "moda.commerce.evidence.suppression": outcome.reason }
        : {}),
    });
  } catch {
    // Telemetry failures must not affect customer delivery decisions.
  }
}

type Provenance = {
  name: string;
  revision: string;
  arguments: Record<string, unknown>;
};

type RecordedEvidence = {
  evidence: CommerceEvidence;
  provenance: Provenance;
};

export const extractTrustedEvidence: EvidenceExtractor = (result) => {
  if (result.status !== "OK") return [];

  const evaluation = CommerceToolOutputs.commerce_evaluate_discount.safeParse(
    result.data,
  );
  if (evaluation.success) return [evaluation.data];

  const recommendations = [
    CommerceToolOutputs.commerce_find_qualifying_products,
    CommerceToolOutputs.commerce_find_similar_products,
  ];
  for (const schema of recommendations) {
    const parsed = schema.safeParse(result.data);
    if (!parsed.success || parsed.data.truncated) continue;
    return parsed.data.alternatives.flatMap((alternative) =>
      alternative.evidence ? [alternative.evidence] : [],
    );
  }
  return [];
};

function immutableCopy<T>(value: T): T {
  return structuredClone(value);
}

function comparable(evidence: CommerceEvidence) {
  const {
    evidenceId: _evidenceId,
    evaluatedAt: _evaluatedAt,
    expiresAt: _expiresAt,
    savings: _savings,
    resultingTotal: _resultingTotal,
    ...stable
  } = evidence;
  return {
    ...stable,
    savings: normalizedMoney(evidence.savings),
    resultingTotal: normalizedMoney(evidence.resultingTotal),
  };
}

function evidenceDigest(evidence: CommerceEvidence): string {
  const { evidenceId: _evidenceId, ...content } = evidence;
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

function validMoney(value: string | null): boolean {
  return value !== null && /^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/.test(value);
}

function normalizedMoney(value: string | null): string | null {
  if (!validMoney(value)) return null;
  const [whole = "", fraction = ""] = value!.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
}

function isQualifying(evidence: CommerceEvidence): boolean {
  return (
    evidence.outcome === "QUALIFIES_FOR_KNOWN_RULES" &&
    evidence.currency !== null &&
    validMoney(evidence.savings) &&
    validMoney(evidence.resultingTotal) &&
    evidence.unresolvedConditions.length === 0
  );
}

function isFresh(evidence: CommerceEvidence, now: number): boolean {
  const evaluatedAt = Date.parse(evidence.evaluatedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  return (
    Number.isFinite(evaluatedAt) &&
    Number.isFinite(expiresAt) &&
    evaluatedAt <= now &&
    now < expiresAt &&
    expiresAt > evaluatedAt &&
    expiresAt - evaluatedAt <= 60_000
  );
}

function sameProvenance(left: Provenance, right: Provenance): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function suppressionReason(error: unknown): "STALE_TURN" | "CANCELLED" | null {
  if (error instanceof Error && error.name === "AbortError") return "CANCELLED";
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "STALE_TURN" || error.code === "CANCELLED")
  )
    return error.code;
  return null;
}

export class TurnEvidenceRegistry {
  private readonly byId = new Map<string, RecordedEvidence>();
  private readonly invalidIds = new Set<string>();

  constructor(
    private readonly expected?: {
      turn: CommerceTurnIdentity;
      grantId: string;
      releaseId: string;
    },
  ) {}

  record(
    descriptor: {
      name: string;
      toolRevisionId: string;
      definitionVersion: string;
    },
    arguments_: Record<string, unknown>,
    result: CommerceToolResult,
    extractEvidence: EvidenceExtractor,
  ): void {
    if (result.status !== "OK") return;
    for (const raw of extractEvidence(result)) {
      const parsed = CommerceEvidenceSchema.safeParse(raw);
      if (!parsed.success) continue;
      const evidence = parsed.data;
      if (evidenceDigest(evidence) !== evidence.evidenceId) {
        this.invalidIds.add(evidence.evidenceId);
        this.byId.delete(evidence.evidenceId);
        continue;
      }
      if (
        this.expected &&
        (canonicalJson(evidence.turn) !== canonicalJson(this.expected.turn) ||
          evidence.grantId !== this.expected.grantId ||
          evidence.releaseId !== this.expected.releaseId)
      ) {
        this.invalidIds.add(evidence.evidenceId);
        this.byId.delete(evidence.evidenceId);
        continue;
      }
      const provenance = {
        name: descriptor.name,
        revision: `${descriptor.toolRevisionId}@${descriptor.definitionVersion}`,
        arguments: immutableCopy(arguments_),
      };
      const existing = this.byId.get(evidence.evidenceId);
      if (existing) {
        if (
          !sameProvenance(existing.provenance, provenance) ||
          canonicalJson(existing.evidence) !== canonicalJson(evidence)
        ) {
          this.invalidIds.add(evidence.evidenceId);
          this.byId.delete(evidence.evidenceId);
        }
        continue;
      }
      if (this.invalidIds.has(evidence.evidenceId)) continue;
      this.byId.set(evidence.evidenceId, {
        evidence,
        provenance,
      });
    }
  }

  async refresh(
    evidenceIds: readonly string[],
    input: {
      remoteCalls: number;
      maxRemoteCalls: number;
      now: () => number;
      assertCurrent: () => Promise<void>;
      replay: (provenance: Provenance) => Promise<CommerceToolResult>;
      extractEvidence: EvidenceExtractor;
    },
  ): Promise<EvidenceRefreshOutcome> {
    const records = evidenceIds.map((id) => this.byId.get(id));
    if (
      records.some((record, index) => !record || this.invalidIds.has(evidenceIds[index]!))
    )
      return { kind: "refer" };

    const now = input.now();
    if (
      (records as RecordedEvidence[]).some(
        (record) =>
          (this.expected &&
            (canonicalJson(record.evidence.turn) !==
              canonicalJson(this.expected.turn) ||
              record.evidence.grantId !== this.expected.grantId ||
              record.evidence.releaseId !== this.expected.releaseId)) ||
          evidenceDigest(record.evidence) !== record.evidence.evidenceId ||
          !isFresh(record.evidence, now),
      )
    )
      return { kind: "refer" };

    const calls = new Map<
      string,
      { provenance: Provenance; evidence: CommerceEvidence[] }
    >();
    for (const record of records as RecordedEvidence[]) {
      const key = canonicalJson({
        name: record.provenance.name,
        revision: record.provenance.revision,
        arguments: record.provenance.arguments,
      });
      if (!calls.has(key))
        calls.set(key, { provenance: record.provenance, evidence: [] });
    }
    if (input.remoteCalls + calls.size > input.maxRemoteCalls)
      return { kind: "refer" };

    for (const call of calls.values()) {
      try {
        await input.assertCurrent();
        const result = await input.replay(call.provenance);
        if (result.status !== "OK") {
          if (result.code === "STALE_TURN")
            return { kind: "suppress", reason: "STALE_TURN" };
          return { kind: "refer" };
        }
        const extracted = input.extractEvidence(result);
        const parsed = extracted.map((raw) => CommerceEvidenceSchema.safeParse(raw));
        const refreshed: CommerceEvidence[] = [];
        for (const item of parsed) {
          if (!item.success) return { kind: "refer" };
          refreshed.push(item.data);
        }
        call.evidence = refreshed;
        if (
          call.evidence.some(
            (evidence) =>
              evidenceDigest(evidence) !== evidence.evidenceId ||
              !isFresh(evidence, input.now()),
          )
        )
          return { kind: "refer" };
      } catch (error) {
        const reason = suppressionReason(error);
        if (reason) return { kind: "suppress", reason };
        return { kind: "refer" };
      }
    }

    try {
      await input.assertCurrent();
    } catch (error) {
      const reason = suppressionReason(error);
      if (reason) return { kind: "suppress", reason };
      return { kind: "refer" };
    }
    for (const record of records as RecordedEvidence[]) {
      const key = canonicalJson(record.provenance);
      const refreshed = calls.get(key)?.evidence ?? [];
      const matches = refreshed.filter(
        (candidate) =>
          candidate.offerId === record.evidence.offerId &&
          canonicalJson(candidate.proposal) === canonicalJson(record.evidence.proposal),
      );
      if (
        matches.length !== 1 ||
        !isQualifying(matches[0]!) ||
        !isQualifying(record.evidence) ||
        canonicalJson(comparable(matches[0]!)) !==
          canonicalJson(comparable(record.evidence))
      )
        return { kind: "refer" };
    }
    return { kind: "accepted" };
  }
}