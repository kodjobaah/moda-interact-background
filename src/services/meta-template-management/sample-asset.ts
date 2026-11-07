import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MetaManagementError } from "./contracts.js";
export const META_TEMPLATE_SAMPLE_ASSET = Object.freeze({
  version: 1, sha256: "14af14ebb7b71df4b0a32d31ba7d8df82a7d18f47e56143a4bc0b5ea46587717", sizeBytes: 28251, width: 505, height: 757,
  contentType: "image/jpeg" as const, filename: "moda-whatsapp-template-sample.jpeg",
  objectKey: "platform/whatsapp/template-submission-samples/v1/14af14ebb7b71df4b0a32d31ba7d8df82a7d18f47e56143a4bc0b5ea46587717.jpeg",
});
export function validateMetaTemplateSample(bytes: Buffer, contentType: unknown): void {
  if (contentType !== "image/jpeg" || bytes.length !== META_TEMPLATE_SAMPLE_ASSET.sizeBytes ||
      bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217 ||
      createHash("sha256").update(bytes).digest("hex") !== META_TEMPLATE_SAMPLE_ASSET.sha256)
    throw new MetaManagementError("META_SAMPLE_INVALID", "blocked");
}
export async function readPackagedMetaTemplateSample(): Promise<Buffer> {
  const bytes = await readFile(new URL("../../../assets/meta-template-samples/v1/14af14ebb7b71df4b0a32d31ba7d8df82a7d18f47e56143a4bc0b5ea46587717.jpeg", import.meta.url));
  validateMetaTemplateSample(bytes, "image/jpeg"); return bytes;
}
