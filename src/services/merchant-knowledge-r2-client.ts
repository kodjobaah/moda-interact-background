import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { MerchantKnowledgeR2Config } from "./merchant-knowledge-r2-config.js";

export interface MerchantKnowledgeR2Client {
  getObject(input: { bucket: string; key: string }): Promise<AsyncIterable<Uint8Array>>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
}

export function createMerchantKnowledgeR2Client(
  config: MerchantKnowledgeR2Config,
): MerchantKnowledgeR2Client {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async getObject({ bucket, key }) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body || !(Symbol.asyncIterator in Object(response.Body))) {
        throw new Error("R2_OBJECT_BODY_UNAVAILABLE");
      }
      return response.Body as AsyncIterable<Uint8Array>;
    },
    async deleteObject({ bucket, key }) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
