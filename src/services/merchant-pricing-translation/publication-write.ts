import { Prisma } from "@prisma/client";

import type { MerchantPricingPublicationPayload } from "./publication-payload.js";
import type { MerchantPricingPublicationTransaction } from "./publication-types.js";

export async function replaceMerchantPricingTranslations(
  transaction: MerchantPricingPublicationTransaction,
  input: {
    planId: string;
    highlightIdByContentKey: Map<string, string>;
    payload: MerchantPricingPublicationPayload;
  },
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    DELETE FROM "billing"."MerchantPricingPlanTranslation"
    WHERE "merchantPricingPlanId" = ${input.planId}
  `);
  await transaction.$executeRaw(Prisma.sql`
    DELETE FROM "billing"."MerchantPricingPlanHighlightTranslation"
    WHERE "merchantPricingPlanHighlightId" IN (
      SELECT "id"
      FROM "billing"."MerchantPricingPlanHighlight"
      WHERE "merchantPricingPlanId" = ${input.planId}
    )
  `);

  const planValues = input.payload.planTranslations.map((translation) => Prisma.sql`
    (${translation.id}, ${input.planId}, ${translation.locale}, ${translation.merchantDescription}, NOW(), NOW())
  `);
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO "billing"."MerchantPricingPlanTranslation" (
      "id", "merchantPricingPlanId", "locale", "merchantDescription", "createdAt", "updatedAt"
    ) VALUES ${Prisma.join(planValues)}
  `);

  if (input.payload.highlightTranslations.length === 0) return;
  const highlightValues = input.payload.highlightTranslations.map((translation) => {
    const highlightId = input.highlightIdByContentKey.get(
      translation.contentKey.toLowerCase(),
    );
    if (!highlightId) {
      throw new Error("Merchant Pricing highlight disappeared during finalisation");
    }
    return Prisma.sql`
      (${translation.id}, ${highlightId}, ${translation.locale}, ${translation.merchantTitle}, ${translation.merchantDescription}, NOW(), NOW())
    `;
  });
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO "billing"."MerchantPricingPlanHighlightTranslation" (
      "id", "merchantPricingPlanHighlightId", "locale", "merchantTitle",
      "merchantDescription", "createdAt", "updatedAt"
    ) VALUES ${Prisma.join(highlightValues)}
  `);
}
