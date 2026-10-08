import type {
  TranslationProvider,
  TranslationProviderResult,
} from "../../providers/translation.provider.js";
import {
  assertExactTranslationBatchResultMembership,
  type TranslationBatchResultMembershipMessages,
} from "./result-membership.js";

export async function applyTranslationProviderResults(input: {
  provider: TranslationProvider;
  outputFileId: string | null;
  errorFileId: string | null;
  missingResultFileMessage: string;
  loadExpectedProviderCustomIds(): Promise<readonly string[]>;
  membershipMessages: TranslationBatchResultMembershipMessages;
  applyResult(result: TranslationProviderResult): Promise<boolean>;
}): Promise<{ applied: number }> {
  const resultFileIds = [input.outputFileId, input.errorFileId].filter(
    (fileId): fileId is string => Boolean(fileId),
  );
  if (resultFileIds.length === 0) {
    throw new Error(input.missingResultFileMessage);
  }

  const resultFiles = await Promise.all(
    resultFileIds.map((fileId) => input.provider.readOutputFile(fileId)),
  );
  const results = resultFiles.flat();
  const expectedProviderCustomIds = await input.loadExpectedProviderCustomIds();
  assertExactTranslationBatchResultMembership(
    expectedProviderCustomIds,
    results,
    input.membershipMessages,
  );

  let applied = 0;
  for (const result of results) {
    if (await input.applyResult(result)) applied += 1;
  }
  return { applied };
}
