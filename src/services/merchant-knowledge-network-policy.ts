/** Host acquisition limits; generic destination policy is the published Shared implementation. */
export const MERCHANT_KNOWLEDGE_MAX_URL_LENGTH = 2048;
export const MERCHANT_KNOWLEDGE_MAX_REDIRECTS = 5;
export const MERCHANT_KNOWLEDGE_ACQUISITION_DEADLINE_MS = 10_000;
export const MERCHANT_KNOWLEDGE_MAX_DECOMPRESSED_BYTES = 1_048_576;
export { MERCHANT_KNOWLEDGE_ACQUISITION_ERROR_CODES, MerchantKnowledgeAcquisitionError, type MerchantKnowledgeAcquisitionErrorCode, type MerchantKnowledgeResolvedAddress, type MerchantKnowledgeResolver, normalizeIpAddress, isPublicIpAddress, resolveAllDnsAnswers, resolveAndValidateDestination, addressesMatch, createPinnedLookup } from "@modainteract/moda-interact-shared/commerce/presentation/node";
