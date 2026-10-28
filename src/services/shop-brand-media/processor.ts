import { isIP } from "node:net";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import {
  assertMediaInput, ShopBrandMediaError,
  decodeShopBrandDomain, encodeShopBrandDomain,
  type ImageTransformer, type PublicMediaProbe, type R2ObjectWriter, type SafeFetcher,
  type ShopBrandMediaInput, type ShopBrandMediaProcessor, type ShopBrandPublicMediaSettings,
} from "./contracts.js";
import { createShopBrandImageTransformer } from "./image-transformer.js";
import { verifyEncodedBrandImage } from "./metadata-verifier.js";
import { createShopBrandPublicMediaProbe } from "./public-probe.js";
import { loadShopBrandR2Credentials } from "./r2-config.js";
import { createBrandR2S3Transport, createShopBrandR2Writer } from "./r2-writer.js";
import { createSafeImageFetcher } from "./safe-fetch.js";

export interface ShopBrandMediaDependencies {
  readConfiguration: () => Promise<ShopBrandPublicMediaSettings>;
  fetcher: SafeFetcher;
  transformer: ImageTransformer;
  writer: R2ObjectWriter;
  probe: PublicMediaProbe;
  logger?: Pick<StructuredLogger, "info" | "error">;
}

/** Public URL is derived only from the validated Admin origin plus a server-generated key. */
export function publicBrandImageUrl(origin: string, objectKey: string): string {
  const url = new URL(origin);
  const [prefix, domain, role, filename] = objectKey.split("/");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || (url.port && url.port !== "443") ||
      !url.hostname.includes(".") || url.hostname.startsWith("[") ||
      isIP(url.hostname) !== 0 || /\.(?:local|localhost|test|invalid|example|internal)$/.test(url.hostname) ||
      prefix !== "shop-brands" || decodeShopBrandDomain(domain) === null ||
      !["logo", "square_logo", "cover_image"].includes(role ?? "") ||
      !/^sha256-[a-f0-9]{64}\.(jpg|png)$/.test(filename ?? "") || objectKey.split("/").length !== 4) {
    throw new ShopBrandMediaError("R2_CONFIGURATION_INVALID");
  }
  return `${url.origin}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}

export function createShopBrandMediaProcessor(input: ShopBrandMediaDependencies): ShopBrandMediaProcessor {
  return {
    async process(source: ShopBrandMediaInput) {
      const startedAt = Date.now();
      try {
        assertMediaInput(source);
        const settings = await input.readConfiguration();
        const fetched = await input.fetcher.fetch(source.sourceUrl);
        const encoded = await input.transformer.transform(fetched.bytes, source.role);
        // Verify actual bytes even when a custom transformer is injected.
        const image = await verifyEncodedBrandImage(encoded.bytes, encoded.contentType);
        if (image.contentSha256 !== encoded.contentSha256 || image.width !== encoded.width ||
            image.height !== encoded.height || image.sizeBytes !== encoded.sizeBytes) {
          throw new ShopBrandMediaError("OUTPUT_VERIFICATION_FAILED");
        }
        const extension = image.contentType === "image/png" ? "png" : "jpg";
        const objectKey = `shop-brands/${encodeShopBrandDomain(source.domain)}/${source.role.toLowerCase()}/sha256-${image.contentSha256}.${extension}`;
        const publicUrl = publicBrandImageUrl(settings.publicOrigin, objectKey);
        await input.writer.putVerified({ bucket: settings.bucketName, objectKey, image });
        await input.probe.verify({ url: publicUrl, image });
        input.logger?.info("shop_brand.media.verified", {
          configurationPurpose: "merchant.knowledge.r2",
          shopId: source.shopId, role: source.role, sourceGeneration: source.sourceGeneration,
          sourceFingerprint: source.sourceFingerprint,
          contentType: image.contentType, sizeBytes: image.sizeBytes,
          contentSha256: image.contentSha256, durationMs: Date.now() - startedAt,
        });
        return {
          objectKey, contentType: image.contentType, width: image.width, height: image.height,
          sizeBytes: image.sizeBytes, contentSha256: image.contentSha256,
          sourceFingerprint: source.sourceFingerprint, sourceGeneration: source.sourceGeneration,
        };
      } catch (error) {
        const failure = error instanceof ShopBrandMediaError
          ? error : new ShopBrandMediaError("UNEXPECTED_FAILURE", true);
        // Deliberately never log provider Error.message, untrusted source URL or credentials.
        input.logger?.error("shop_brand.media.failed", {
          configurationPurpose: "merchant.knowledge.r2",
          ...(typeof source?.shopId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(source.shopId)
            ? { shopId: source.shopId } : {}),
          ...(["LOGO", "SQUARE_LOGO", "COVER_IMAGE"].includes(source?.role)
            ? { role: source.role } : {}),
          ...(Number.isSafeInteger(source?.sourceGeneration) ? { sourceGeneration: source.sourceGeneration } : {}),
          reasonCode: failure.code, retryable: failure.retryable,
          ...(failure.providerMessage ? { providerMessage: failure.providerMessage } : {}),
          durationMs: Date.now() - startedAt,
        });
        throw failure;
      }
    },
  };
}

/** Server-side composition only; no database reads or R2 calls during import. */
export function createProductionShopBrandMediaProcessor(): ShopBrandMediaProcessor {
  const logger = createLogger({ serviceName: "moda-background-runtime",
    environment: resolveDeploymentEnvironmentName() });
  const fetcher = createSafeImageFetcher();
  return createShopBrandMediaProcessor({
    // The injectable processor must not instantiate Prisma merely by being imported.
    // Defer the production configuration composition until an actual processing call.
    readConfiguration: async () => {
      const { readShopBrandPublicMediaConfiguration } = await import("../platform-configuration/consumers.js");
      return readShopBrandPublicMediaConfiguration();
    },
    fetcher,
    transformer: createShopBrandImageTransformer(),
    writer: createShopBrandR2Writer(async () => {
      const { readR2Configuration } = await import("../platform-configuration/consumers.js");
      const configuration = await readR2Configuration();
      const credentials = loadShopBrandR2Credentials(configuration);
      return createBrandR2S3Transport(credentials);
    }),
    probe: createShopBrandPublicMediaProbe(fetcher),
    logger,
  });
}
