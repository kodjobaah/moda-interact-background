export type TranslationBatchResultIdentity = {
  providerCustomId: string;
};

export type TranslationBatchResultMembershipMessages = {
  countMismatch: string;
  unknownProviderCustomId: (providerCustomId: string) => string;
  duplicateProviderCustomId: string;
};

export function assertExactTranslationBatchResultMembership(
  expectedProviderCustomIds: readonly string[],
  results: readonly TranslationBatchResultIdentity[],
  messages: TranslationBatchResultMembershipMessages,
): void {
  if (results.length !== expectedProviderCustomIds.length) {
    throw new Error(messages.countMismatch);
  }

  const expectedIds = new Set(expectedProviderCustomIds);
  const seenIds = new Set<string>();
  for (const result of results) {
    if (!expectedIds.has(result.providerCustomId)) {
      throw new Error(messages.unknownProviderCustomId(result.providerCustomId));
    }
    if (seenIds.has(result.providerCustomId)) {
      throw new Error(messages.duplicateProviderCustomId);
    }
    seenIds.add(result.providerCustomId);
  }
}
