import {
  canonicalJson,
  CommerceEvidenceSchema,
  type CommerceEvidence,
  type CommerceToolResult,
} from "@modainteract/moda-interact-shared/commerce";

export type EvidenceExtractor = (
  result: CommerceToolResult,
) => unknown[];

type Provenance = {
  name: string;
  revision: string;
  arguments: Record<string, unknown>;
};

type RecordedEvidence = {
  evidence: CommerceEvidence;
  provenance: Provenance;
};

function immutableCopy<T>(value: T): T {
  return structuredClone(value);
}

function comparable(evidence: CommerceEvidence) {
  const {
    evidenceId: _evidenceId,
    evaluatedAt: _evaluatedAt,
    expiresAt: _expiresAt,
    ...stable
  } = evidence;
  return stable;
}

export class TurnEvidenceRegistry {
  private readonly byId = new Map<string, RecordedEvidence>();

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
      const evidence = CommerceEvidenceSchema.parse(raw);
      this.byId.set(evidence.evidenceId, {
        evidence,
        provenance: {
          name: descriptor.name,
          revision: `${descriptor.toolRevisionId}@${descriptor.definitionVersion}`,
          arguments: immutableCopy(arguments_),
        },
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
  ): Promise<boolean> {
    const records = evidenceIds.map((id) => this.byId.get(id));
    if (records.some((record) => !record)) return false;

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
    if (input.remoteCalls + calls.size > input.maxRemoteCalls) return false;

    for (const call of calls.values()) {
      await input.assertCurrent();
      const result = await input.replay(call.provenance);
      if (result.status !== "OK") return false;
      call.evidence = input.extractEvidence(result).map((raw) =>
        CommerceEvidenceSchema.parse(raw),
      );
      if (
        call.evidence.some(
          (evidence) => Date.parse(evidence.evaluatedAt) > input.now(),
        )
      )
        return false;
    }

    await input.assertCurrent();
    return records.every((record) => {
      const key = canonicalJson({
        name: record!.provenance.name,
        revision: record!.provenance.revision,
        arguments: record!.provenance.arguments,
      });
      const refreshed = calls.get(key)?.evidence ?? [];
      const matches = refreshed.filter(
        (evidence) =>
          canonicalJson(comparable(evidence)) ===
            canonicalJson(comparable(record!.evidence)) &&
          evidence.outcome === "QUALIFIES_FOR_KNOWN_RULES" &&
          Date.parse(evidence.expiresAt) > input.now(),
      );
      return matches.length === 1;
    });
  }
}