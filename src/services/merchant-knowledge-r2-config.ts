export interface MerchantKnowledgeR2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  maxUploadBytes: number;
  maxXlsxUncompressedBytes: number;
}

export class MerchantKnowledgeR2ConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MerchantKnowledgeR2ConfigError";
  }
}

function requiredTrimmed(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new MerchantKnowledgeR2ConfigError(`MISSING_${name}`);
  return value;
}

function requiredPositiveSafeInteger(environment: NodeJS.ProcessEnv, name: string): number {
  const value = requiredTrimmed(environment, name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MerchantKnowledgeR2ConfigError(`INVALID_${name}`);
  }
  return parsed;
}

export function loadMerchantKnowledgeR2Config(
  environment: NodeJS.ProcessEnv = process.env,
): MerchantKnowledgeR2Config {
  const endpoint = requiredTrimmed(environment, "MERCHANT_KNOWLEDGE_R2_ENDPOINT");
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new MerchantKnowledgeR2ConfigError("INVALID_MERCHANT_KNOWLEDGE_R2_ENDPOINT");
  }
  if (parsedEndpoint.protocol !== "https:" || !parsedEndpoint.hostname) {
    throw new MerchantKnowledgeR2ConfigError("INVALID_MERCHANT_KNOWLEDGE_R2_ENDPOINT");
  }

  return {
    endpoint: parsedEndpoint.toString().replace(/\/$/, ""),
    bucket: requiredTrimmed(environment, "MERCHANT_KNOWLEDGE_R2_BUCKET"),
    accessKeyId: requiredTrimmed(environment, "MERCHANT_KNOWLEDGE_R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredTrimmed(environment, "MERCHANT_KNOWLEDGE_R2_SECRET_ACCESS_KEY"),
    maxUploadBytes: requiredPositiveSafeInteger(environment, "MERCHANT_KNOWLEDGE_MAX_UPLOAD_BYTES"),
    maxXlsxUncompressedBytes: requiredPositiveSafeInteger(
      environment,
      "MERCHANT_KNOWLEDGE_MAX_XLSX_UNCOMPRESSED_BYTES",
    ),
  };
}
