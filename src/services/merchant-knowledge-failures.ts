import { MerchantKnowledgeAcquisitionError } from "./merchant-knowledge-web-page-acquirer.js";
import { MerchantKnowledgeUploadedAssetAcquisitionError } from "./merchant-knowledge-uploaded-asset-acquirer.js";
import { MerchantKnowledgeEmbeddingError } from "./merchant-knowledge-embedding.js";

export const MERCHANT_KNOWLEDGE_PERMANENT_FAILURE_CODES = [
  "SOURCE_TYPE_UNSUPPORTED",
  "LOCATOR_FORMAT_MISMATCH",
  "UNSAFE_URL",
  "UNSUPPORTED_MEDIA_TYPE",
  "UPLOAD_HASH_MISMATCH",
  "UPLOAD_FORMAT_INVALID",
  "XLSX_ACTIVE_CONTENT",
  "CONTENT_INVALID",
  "HTTP_STATUS_PERMANENT",
  "EMBEDDING_PROVIDER_REJECTED",
  "EMBEDDING_VECTOR_INVALID",
] as const;

export const MERCHANT_KNOWLEDGE_TRANSIENT_FAILURE_CODES = [
  "DNS_TEMPORARY",
  "FETCH_TIMEOUT",
  "HTTP_429",
  "HTTP_5XX",
  "R2_TEMPORARY",
  "EMBEDDING_PROVIDER_TEMPORARY",
  "DATABASE_TRANSIENT",
] as const;

export type MerchantKnowledgePermanentFailureCode =
  (typeof MERCHANT_KNOWLEDGE_PERMANENT_FAILURE_CODES)[number];
export type MerchantKnowledgeTransientFailureCode =
  (typeof MERCHANT_KNOWLEDGE_TRANSIENT_FAILURE_CODES)[number];
export type MerchantKnowledgeFailureCode =
  | MerchantKnowledgePermanentFailureCode
  | MerchantKnowledgeTransientFailureCode
  | "RETRIES_EXHAUSTED";

export class MerchantKnowledgeProcessingError extends Error {
  constructor(
    readonly failureCode: MerchantKnowledgeFailureCode,
    readonly retryable: boolean,
  ) {
    super(failureCode);
    this.name = "MerchantKnowledgeProcessingError";
  }
}

export function classifyMerchantKnowledgeProcessingError(
  error: unknown,
): MerchantKnowledgeProcessingError {
  if (error instanceof MerchantKnowledgeProcessingError) return error;

  if (error instanceof MerchantKnowledgeEmbeddingError) {
    return new MerchantKnowledgeProcessingError(
      error.code === "EMBEDDING_PROVIDER_TEMPORARY"
        ? "EMBEDDING_PROVIDER_TEMPORARY"
        : error.code === "EMBEDDING_PROVIDER_REJECTED"
          ? "EMBEDDING_PROVIDER_REJECTED"
          : "EMBEDDING_VECTOR_INVALID",
      error.retryable,
    );
  }

  if (error instanceof MerchantKnowledgeAcquisitionError) {
    switch (error.code) {
      case "DNS_TEMPORARY_FAILURE":
        return new MerchantKnowledgeProcessingError("DNS_TEMPORARY", true);
      case "REQUEST_DEADLINE":
        return new MerchantKnowledgeProcessingError("FETCH_TIMEOUT", true);
      case "HTTP_STATUS_TRANSIENT":
        return new MerchantKnowledgeProcessingError("HTTP_5XX", true);
      case "DNS_FAILURE":
      case "RESPONSE_READ_FAILED":
        return new MerchantKnowledgeProcessingError(
          error.retryable ? "DNS_TEMPORARY" : "CONTENT_INVALID",
          error.retryable,
        );
      case "UNSUPPORTED_MEDIA_TYPE":
        return new MerchantKnowledgeProcessingError("UNSUPPORTED_MEDIA_TYPE", false);
      case "HTTP_STATUS_PERMANENT":
        return new MerchantKnowledgeProcessingError("HTTP_STATUS_PERMANENT", false);
      case "INVALID_URL":
      case "DENIED_DESTINATION":
      case "TOO_MANY_REDIRECTS":
      case "INVALID_REDIRECT":
      case "CONNECTION_PEER_MISMATCH":
        return new MerchantKnowledgeProcessingError("UNSAFE_URL", false);
      case "DNS_NO_ADDRESSES":
      case "UNSUPPORTED_CONTENT_ENCODING":
      case "BODY_TOO_LARGE":
        return new MerchantKnowledgeProcessingError("CONTENT_INVALID", false);
    }
  }

  if (error instanceof MerchantKnowledgeUploadedAssetAcquisitionError) {
    switch (error.code) {
      case "R2_READ_FAILED":
      case "INVALID_R2_BODY":
        return new MerchantKnowledgeProcessingError("R2_TEMPORARY", true);
      case "ASSET_INTEGRITY_MISMATCH":
        return new MerchantKnowledgeProcessingError("UPLOAD_HASH_MISMATCH", false);
      case "UNSAFE_XLSX":
        return new MerchantKnowledgeProcessingError("XLSX_ACTIVE_CONTENT", false);
      case "INVALID_FILENAME":
      case "INVALID_UTF8":
      case "INVALID_CSV":
      case "INVALID_XLSX":
      case "ASSET_NOT_FOUND":
      case "ASSET_NOT_ACQUIRABLE":
      case "INVALID_ASSET_METADATA":
      case "UPLOAD_TOO_LARGE":
      case "ASSET_EXTRACTION_FAILED":
        return new MerchantKnowledgeProcessingError("UPLOAD_FORMAT_INVALID", false);
    }
  }

  return new MerchantKnowledgeProcessingError("DATABASE_TRANSIENT", true);
}