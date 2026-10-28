import { createHash } from "node:crypto";
import {
  HeadObjectCommand, PutObjectCommand, S3Client,
  type HeadObjectCommandInput, type HeadObjectCommandOutput, type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { ShopBrandMediaError, type R2ObjectWriter } from "./contracts.js";
import type { ShopBrandR2Credentials } from "./r2-config.js";

export const SHOP_BRAND_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Narrow injectable S3 boundary; no other R2 operation or credentials reach the processor. */
export interface BrandR2Transport {
  head(input: HeadObjectCommandInput): Promise<HeadObjectCommandOutput>;
  put(input: PutObjectCommandInput): Promise<void>;
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
    .replace(/\s+/g, " ").trim().slice(0, 300);
  return message || undefined;
}

export function createBrandR2S3Transport(credentials: ShopBrandR2Credentials): BrandR2Transport {
  const client = new S3Client({ endpoint: credentials.endpoint, region: "auto", forcePathStyle: true,
    credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey },
    maxAttempts: 2 });
  return {
    head(input) { return client.send(new HeadObjectCommand(input)); },
    async put(input) { await client.send(new PutObjectCommand(input)); },
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

export function createShopBrandR2Writer(transportOrFactory: BrandR2Transport | (() => Promise<BrandR2Transport>)): R2ObjectWriter {
  return {
    async putVerified({ bucket, objectKey, image }): Promise<void> {
      if (!/^(?!.*\.\.)(?!.*\.-|.*-\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
          /^\d+\.\d+\.\d+\.\d+$/.test(bucket) ||
          !/^shop-brands\/[A-Za-z0-9_-]{1,128}\/(logo|square_logo|cover_image)\/sha256-[a-f0-9]{64}\.(jpg|png)$/.test(objectKey) ||
          !/^[a-f0-9]{64}$/.test(image.contentSha256) ||
          createHash("sha256").update(image.bytes).digest("hex") !== image.contentSha256 ||
          image.sizeBytes !== image.bytes.length ||
          (image.contentType === "image/jpeg" ? !objectKey.endsWith(".jpg") : !objectKey.endsWith(".png"))) {
        throw new ShopBrandMediaError("OUTPUT_VERIFICATION_FAILED");
      }
      const transport = typeof transportOrFactory === "function" ? await transportOrFactory() : transportOrFactory;
      const head = async (): Promise<HeadObjectCommandOutput | null> => {
        try { return await transport.head({ Bucket: bucket, Key: objectKey }); }
        catch (error) { if (isMissing(error)) return null; throw r2Failure(error, transport); }
      };
      let existing = await head();
      if (existing === null) {
        try {
          await transport.put({
            Bucket: bucket, Key: objectKey, Body: image.bytes,
            ContentType: image.contentType, ContentLength: image.sizeBytes,
            CacheControl: SHOP_BRAND_CACHE_CONTROL,
            Metadata: { sha256: image.contentSha256 },
            IfNoneMatch: "*", // Concurrent identical writes may reuse; never overwrite a collision.
          });
        } catch (error) {
          if (httpStatus(error) !== 412 && httpStatus(error) !== 409) throw r2Failure(error, transport);
          // Another producer may have won this immutable key race.
        }
        existing = await head();
      }
      if (existing === null) throw new ShopBrandMediaError("R2_UNAVAILABLE", true);
      if (existing.ContentType !== image.contentType || existing.ContentLength !== image.sizeBytes ||
          existing.Metadata?.sha256 !== image.contentSha256 ||
          existing.CacheControl !== SHOP_BRAND_CACHE_CONTROL) {
        throw new ShopBrandMediaError("R2_OBJECT_MISMATCH");
      }
    },
  };
}
