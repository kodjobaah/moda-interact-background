import { createHash } from "node:crypto";
import {
  HeadObjectCommand, PutObjectCommand, S3Client,
  type HeadObjectCommandInput, type HeadObjectCommandOutput, type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import {
  isShopBrandDomainSegment, ShopBrandMediaError,
  type R2ObjectWriter, type VerifiedBrandImage,
} from "./contracts.js";
import type { ShopBrandR2Credentials } from "./r2-config.js";

export const SHOP_BRAND_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Narrow injectable S3 boundary; no other R2 operation or credentials reach the processor. */
export interface BrandR2Transport {
  head(input: HeadObjectCommandInput, signal?: AbortSignal): Promise<HeadObjectCommandOutput>;
  put(input: PutObjectCommandInput, signal?: AbortSignal): Promise<void>;
  safeErrorMessage?(error: unknown): string | undefined;
}

export function sanitizeR2ProviderMessage(error: unknown, credentials: ShopBrandR2Credentials): string | undefined {
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") return undefined;
  let message = [...error.message].map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  for (const secret of [credentials.secretAccessKey, credentials.accessKeyId]) {
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  message = message
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/((?:access.?key(?:.?id)?|secret.?key|session.?token|security.?token|token|password|signature|credential|api.?key)\s*[:=]\s*)[^\s,;&"'<>]+/gi, "$1[REDACTED]")
    .replace(/\bhttps?:\/\/[^\s,;]+/gi, "[URL REDACTED]")
    .replace(/\s+/g, " ").trim().slice(0, 300);
  return message || undefined;
}

export function createBrandR2S3Transport(credentials: ShopBrandR2Credentials): BrandR2Transport {
  const client = new S3Client({ endpoint: credentials.endpoint, region: "auto", forcePathStyle: true,
    credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey },
    maxAttempts: 2 });
  return {
    head(input, signal) {
      return client.send(new HeadObjectCommand(input), signal ? { abortSignal: signal } : {});
    },
    async put(input, signal) {
      await client.send(new PutObjectCommand(input), signal ? { abortSignal: signal } : {});
    },
    safeErrorMessage(error) { return sanitizeR2ProviderMessage(error, credentials); },
  };
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("$metadata" in error)) return undefined;
  const metadata = error.$metadata;
  if (!metadata || typeof metadata !== "object" || !("httpStatusCode" in metadata)) return undefined;
  return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}
function isMissing(error: unknown): boolean {
  if (httpStatus(error) === 404) return true;
  return error !== null && typeof error === "object" && "name" in error &&
    (error.name === "NotFound" || error.name === "NoSuchKey");
}
function r2Failure(error: unknown, transport: BrandR2Transport): ShopBrandMediaError {
  if (error instanceof ShopBrandMediaError) return error;
  const status = httpStatus(error);
  return new ShopBrandMediaError("R2_UNAVAILABLE",
    status === undefined || status >= 500 || status === 429 || status === 408 || status === 409,
    transport.safeErrorMessage?.(error));
}
function validBucket(bucket: string): boolean {
  return /^(?!.*\.\.)(?!.*\.-|.*-\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(bucket);
}

/** Shared guarded immutable PUT/HEAD mechanics; each caller supplies its own strict key policy. */
export async function putGuardedImmutableR2Object(input: Readonly<{
  transportOrFactory: BrandR2Transport | (() => Promise<BrandR2Transport>);
  bucket: string;
  objectKey: string;
  image: VerifiedBrandImage;
  acceptsKey: (objectKey: string) => boolean;
  signal?: AbortSignal;
}>): Promise<void> {
  const { bucket, objectKey, image } = input;
  if (!validBucket(bucket) || !input.acceptsKey(objectKey) ||
      !["image/jpeg", "image/png"].includes(image.contentType) ||
      !/^[a-f0-9]{64}$/.test(image.contentSha256) ||
      createHash("sha256").update(image.bytes).digest("hex") !== image.contentSha256 ||
      image.sizeBytes !== image.bytes.length || image.width !== 1125 || image.height !== 600) {
    throw new ShopBrandMediaError("OUTPUT_VERIFICATION_FAILED");
  }
  const transport = typeof input.transportOrFactory === "function"
    ? await input.transportOrFactory() : input.transportOrFactory;
  const head = async (): Promise<HeadObjectCommandOutput | null> => {
    try { return input.signal
      ? await transport.head({ Bucket: bucket, Key: objectKey }, input.signal)
      : await transport.head({ Bucket: bucket, Key: objectKey }); }
    catch (error) { if (isMissing(error)) return null; throw r2Failure(error, transport); }
  };
  let existing = await head();
  if (existing === null) {
    try {
      const putInput = {
        Bucket: bucket, Key: objectKey, Body: image.bytes,
        ContentType: image.contentType, ContentLength: image.sizeBytes,
        CacheControl: SHOP_BRAND_CACHE_CONTROL,
        Metadata: { sha256: image.contentSha256 },
        IfNoneMatch: "*",
      } satisfies PutObjectCommandInput;
      if (input.signal) await transport.put(putInput, input.signal);
      else await transport.put(putInput);
    } catch (error) {
      if (httpStatus(error) !== 412 && httpStatus(error) !== 409) throw r2Failure(error, transport);
    }
    existing = await head();
  }
  if (existing === null) throw new ShopBrandMediaError("R2_UNAVAILABLE", true);
  if (existing.ContentType !== image.contentType || existing.ContentLength !== image.sizeBytes ||
      existing.Metadata?.sha256 !== image.contentSha256 || existing.CacheControl !== SHOP_BRAND_CACHE_CONTROL) {
    throw new ShopBrandMediaError("R2_OBJECT_MISMATCH");
  }
}

function isShopBrandObjectKey(objectKey: string, image: VerifiedBrandImage): boolean {
  const [prefix, domain, role, filename] = objectKey.split("/");
  return prefix === "shop-brands" && isShopBrandDomainSegment(domain) &&
    ["logo", "square_logo", "cover_image"].includes(role ?? "") &&
    /^sha256-[a-f0-9]{64}\.(jpg|png)$/.test(filename ?? "") && objectKey.split("/").length === 4 &&
    (image.contentType === "image/jpeg" ? objectKey.endsWith(".jpg") : objectKey.endsWith(".png"));
}

export function createShopBrandR2Writer(
  transportOrFactory: BrandR2Transport | (() => Promise<BrandR2Transport>),
): R2ObjectWriter {
  return {
    putVerified({ bucket, objectKey, image }) {
      return putGuardedImmutableR2Object({
        transportOrFactory, bucket, objectKey, image,
        acceptsKey: (key) => isShopBrandObjectKey(key, image),
      });
    },
  };
}
