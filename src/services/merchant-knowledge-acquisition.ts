export interface AcquiredMerchantKnowledgeDocument {
  contentType: string;
  extractedText: string;
  resolvedUrl: string | null;
  fetchedAt: Date | null;
}

export interface MerchantKnowledgeWebPageAcquirer {
  acquire(input: {
    requestedUrl: string;
  }): Promise<AcquiredMerchantKnowledgeDocument>;
}

export interface MerchantKnowledgeUploadedAssetAcquirer {
  acquire(input: {
    shopId: string;
    assetId: string;
    dataFormatKey: "CSV" | "XLSX";
  }): Promise<AcquiredMerchantKnowledgeDocument>;
}