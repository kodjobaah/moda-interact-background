import type { ModaSupportedLanguageTag } from "@modainteract/moda-interact-shared/internationalization";
import {
  canonicalJson,
  matchesSubset,
  finalResponseSchema,
  finalResponseToolSchema,
  verifyResponseContract,
  CommerceToolOutputs,
  CommerceResponseDispositionSchema,
  readCommerceObservedShippingSelections,
  readCommerceRecommendationSelection,
  type CommerceResponseContract,
  type Digest,
  type SubsetSchema,
} from "@modainteract/moda-interact-shared/commerce";
import type {
  TerminalDecisionPort,
  TerminalDecisionInput,
  TerminalToolDescriptor,
} from "@modainteract/moda-interact-shared/commerce/runner";

const SELECTIONS = [
  "productDetailSelections",
  "productOptionSelections",
  "productRecommendations",
] as const;
const KNOWN = new Set<string>([
  ...SELECTIONS,
  "productRecommendationVersion",
  "shippingInformationSelection",
  "responseDisposition",
]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function currentProducts(observations: TerminalDecisionInput["observations"]) {
  return observations.flatMap((observation) => {
    if (
      observation.tool !== "commerce_get_product" &&
      observation.tool !== "commerce_search_products"
    )
      return [];
    const result = observation.result;
    if (!object(result) || result.status !== "OK") return [];
    const parsed = CommerceToolOutputs[observation.tool].safeParse(result.data);
    if (!parsed.success) return [];
    const products =
      "product" in parsed.data
        ? parsed.data.product
          ? [parsed.data.product]
          : []
        : "products" in parsed.data
          ? parsed.data.products
          : [];
    return products;
  });
}

function malformedCurrentProductObservation(
  observations: TerminalDecisionInput["observations"],
): boolean {
  return observations.some(
    (observation) =>
      (observation.tool === "commerce_get_product" ||
        observation.tool === "commerce_search_products") &&
      object(observation.result) &&
      observation.result.status === "OK" &&
      !CommerceToolOutputs[observation.tool].safeParse(observation.result.data)
        .success,
  );
}

/** Application mapping only. The runner retains raw transport and applies all
 * canonical final/grounding/referral checks to the separate decision. */
export function makeRecoveryTerminalFinalizer(input: {
  responseContract: CommerceResponseContract;
  responseContractHash: string;
  digest: Digest;
  platform: "SHOPIFY" | "WOOCOMMERCE";
  locale: ModaSupportedLanguageTag;
  hasEligibleEvidence?: (evidenceIds: readonly string[]) => boolean;
}): TerminalDecisionPort | null {
  const contract = verifyResponseContract(
    input.responseContract,
    input.responseContractHash,
    input.digest,
  );
  const details = contract.detailsSchema;
  if (
    details.type !== "object" ||
    (details.required?.length ?? 0) > 0 ||
    Object.keys(details.properties ?? {}).some((key) => !KNOWN.has(key))
  )
    return null;
  for (const field of SELECTIONS) {
    const selection = details.properties?.[field];
    if (!selection) continue;
    const item = selection.items;
    const variantType = item?.properties?.variantId?.type;
    if (
      selection.type !== "array" ||
      item?.type !== "object" ||
      item.properties?.productId?.type !== "string" ||
      !(
        variantType === "string" ||
        (Array.isArray(variantType) && variantType.includes("string"))
      ) ||
      !item.required?.includes("productId") ||
      !item.required.includes("variantId") ||
      (selection.maxItems !== undefined && selection.maxItems < 1)
    )
      return null;
  }
  for (const field of [
    "productDetailSelections",
    "productOptionSelections",
  ] as const) {
    const item = details.properties?.[field]?.items;
    if (
      item &&
      (Object.keys(item.properties ?? {}).some(
        (key) => key !== "productId" && key !== "variantId",
      ) ||
        item.required?.some(
          (key) => key !== "productId" && key !== "variantId",
        ))
    )
      return null;
  }
  const recommendationVersion =
    details.properties?.productRecommendationVersion;
  if (details.properties?.productRecommendations || recommendationVersion) {
    if (
      !details.properties?.productRecommendations ||
      recommendationVersion?.type !== "string" ||
      recommendationVersion.enum?.length !== 1 ||
      recommendationVersion.enum[0] !== "1"
    )
      return null;
  }
  const supportedDispositions = new Set<string>(
    CommerceResponseDispositionSchema.options,
  );
  const pinnedDisposition = details.properties?.responseDisposition;
  if (
    pinnedDisposition &&
    (pinnedDisposition.type !== "string" ||
      !pinnedDisposition.enum?.length ||
      pinnedDisposition.enum.some(
        (value) =>
          typeof value !== "string" || !supportedDispositions.has(value),
      ))
  )
    return null;
  const envelope = finalResponseToolSchema(contract);
  const common: Record<string, unknown> = {};
  for (const key of [
    "replyText",
    "detectedLanguageTag",
    "detectedLanguageConfidence",
    "evidenceIds",
  ] as const) {
    const property = envelope.properties?.[key];
    if (!property) return null;
    common[key] = structuredClone(property);
  }
  const mappings = new Map<
    string,
    {
      fields: string[];
      optional: string[];
      kind: "ANSWER" | "REFER_TO_STORE";
      fixed?: Record<string, unknown>;
      identity?: "productDetailSelections" | "productOptionSelections";
    }
  >();
  const terminalTools: TerminalToolDescriptor[] = [];
  function add(
    name: string,
    description: string,
    fields: string[],
    kind: "ANSWER" | "REFER_TO_STORE" = "ANSWER",
    fixed?: Record<string, unknown>,
  ) {
    const properties = { ...common };
    if (kind === "REFER_TO_STORE") {
      delete properties.evidenceIds;
      const reason = envelope.properties?.referralReason;
      if (!reason) return;
      properties.referralReason = {
        ...structuredClone(reason),
        type: "string",
        enum: reason.enum.filter((value) => typeof value === "string"),
      };
    }
    for (const field of fields) {
      properties[field] = structuredClone(details.properties![field]!);
      if (SELECTIONS.includes(field as (typeof SELECTIONS)[number]))
        properties[field] = {
          ...details.properties![field]!,
          minItems: Math.max(1, details.properties![field]!.minItems ?? 0),
        };
    }
    if (name === "recovery_complete_shipping") {
      const source = details.properties!.responseDisposition!;
      const allowed =
        source.enum?.filter(
          (value) =>
            typeof value === "string" &&
            readCommerceRecommendationSelection({ responseDisposition: value })
              ?.responseDisposition === value,
        ) ?? [];
      if (!allowed.length) return;
      properties.responseDisposition = {
        ...structuredClone(source),
        enum: allowed,
      };
    }
    const required = Object.keys(properties);
    const optional =
      kind === "ANSWER" &&
      fields.some((field) =>
        SELECTIONS.includes(field as (typeof SELECTIONS)[number]),
      )
        ? ["shippingInformationSelection", "responseDisposition"].filter(
            (field) => details.properties?.[field] !== undefined,
          )
        : [];
    for (const field of optional)
      properties[field] = structuredClone(details.properties![field]!);
    terminalTools.push({
      name,
      description,
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    });
    mappings.set(name, { fields, optional, kind, ...(fixed ? { fixed } : {}) });
  }
  for (const [field, name, purpose] of [
    [
      "productDetailSelections",
      "recovery_complete_details",
      "product facts, catalogue, category or availability answers",
    ],
    [
      "productOptionSelections",
      "recovery_complete_options",
      "product option answers",
    ],
  ] as const) {
    const selection = details.properties?.[field];
    if (
      selection?.type === "array" &&
      selection.items?.type === "object" &&
      (selection.maxItems === undefined || selection.maxItems > 0)
    ) {
      const selectedPairs = {
        ...structuredClone(selection),
        minItems: Math.max(1, selection.minItems ?? 0),
      };
      terminalTools.push({
        name,
        description: `Select exact current observed identities for ${purpose}. Only selectedPairs is required; the application supplies verified factual wording and resolved language.`,
        inputSchema: {
          type: "object",
          properties: { selectedPairs },
          required: ["selectedPairs"],
          additionalProperties: false,
        },
      });
      mappings.set(name, {
        fields: [],
        optional: [],
        kind: "ANSWER",
        identity: field,
      });
      add(
        `${name}_with_context`,
        `Complete ${purpose} with explicitly supplied wording/evidence/shipping/disposition/language-detection adjuncts. Use the minimal identity tool when those adjuncts are unnecessary.`,
        [field],
      );
    }
  }
  if (
    details.properties?.productRecommendations?.type === "array" &&
    details.properties?.productRecommendationVersion?.type === "string"
  )
    add(
      "recovery_complete_recommendations",
      "Complete verified recommendations using model-selected exact observed identities and all pinned scope, quantity and promotion fields. No new discount authority.",
      ["productRecommendationVersion", "productRecommendations"],
    );
  const disposition = details.properties?.responseDisposition;
  if (
    details.properties?.shippingInformationSelection?.type === "object" &&
    disposition?.type === "string"
  )
    add(
      "recovery_complete_shipping",
      "Complete shipping information using an exact successful current-turn shipping selection and explicit pinned response disposition, including null/null only for an observed generic policy.",
      ["shippingInformationSelection", "responseDisposition"],
    );
  if (
    disposition?.type === "string" &&
    disposition.enum?.includes("SHIPPING_INFORMATION_UNVERIFIED")
  ) {
    if (details.properties?.shippingInformationSelection?.type === "object")
      add(
        "recovery_complete_shipping_unverified_selection",
        "Explain a shipping limitation for the exact observed current-turn shipping identity; preserve its product/variant or generic null/null selection.",
        ["shippingInformationSelection"],
        "ANSWER",
        { responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED" },
      );
    add(
      "recovery_complete_shipping_unverified",
      "Explain the observed shipping limitation. Valid only with matching successful current-turn shipping information; never a substitute for unavailable product selections.",
      [],
      "ANSWER",
      { responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED" },
    );
  }
  add(
    "recovery_complete_answer",
    "Complete a legitimate nonproduct answer or clarification. Not permitted to bypass required current product or shipping grounding. Never invent selections or evidence.",
    [],
  );
  if (
    disposition?.type === "string" &&
    disposition.enum?.includes("OUT_OF_SCOPE_REDIRECT")
  )
    add(
      "recovery_complete_redirect",
      "Complete a legitimate out-of-scope redirect under existing application rules.",
      [],
      "ANSWER",
      { responseDisposition: "OUT_OF_SCOPE_REDIRECT" },
    );
  add(
    "recovery_complete_referral",
    "Refer to the store using the exact required canonical referral reason. No product selections or evidence claims.",
    [],
    "REFER_TO_STORE",
  );
  const schema = finalResponseSchema(contract);
  return {
    responseContractHash: input.responseContractHash,
    batchMode: "atomic",
    terminalTools,
    selectTools: ({ observations, requiredReferral }) => {
      if (requiredReferral) return ["recovery_complete_referral"];
      if (malformedCurrentProductObservation(observations))
        return ["recovery_complete_referral"];
      const productsObserved = currentProducts(observations).length > 0;
      const shipping = readCommerceObservedShippingSelections(
        observations,
        input.platform,
      );
      const needsProduct =
        productsObserved &&
        SELECTIONS.some((field) =>
          Object.hasOwn(details.properties ?? {}, field),
        );
      return terminalTools
        .map((tool) => tool.name)
        .filter((name) => {
          if (name === "recovery_complete_referral") return true;
          if (
            name === "recovery_complete_answer" ||
            name === "recovery_complete_redirect"
          )
            return !needsProduct;
          if (name === "recovery_complete_shipping_unverified")
            return shipping.some(
              (pair) => pair.productId === null && pair.variantId === null,
            );
          if (name.startsWith("recovery_complete_shipping"))
            return shipping.length > 0;
          return productsObserved;
        });
    },
    project: ({ binding, call, calls, requiredReferral, observations }) => {
      const invalid = () => ({ kind: "invalid" as const, binding });
      const mapping = mappings.get(call.name);
      const descriptor = terminalTools.find((tool) => tool.name === call.name);
      if (
        !mapping ||
        !descriptor ||
        !object(call.arguments) ||
        !Array.isArray(calls) ||
        !calls.length
      )
        return invalid();
      // Atomic admission is generic; application semantics cover EVERY call.
      // Rich completion retains its prior single/equivalent behavior.
      if (
        calls.some((member) => member.name !== call.name) ||
        (!mapping.identity &&
          calls.some(
            (member) =>
              canonicalJson(member.arguments) !== canonicalJson(call.arguments),
          ))
      )
        return invalid();
      const args = call.arguments;
      if (
        !mapping.identity &&
        (args.detectedLanguageTag === null) !==
          (args.detectedLanguageConfidence === null)
      )
        return invalid();
      if (
        mapping.kind === "REFER_TO_STORE" &&
        (typeof args.referralReason !== "string" || !args.referralReason)
      )
        return invalid();
      const properties = (descriptor.inputSchema as SubsetSchema).properties!;
      const required = (descriptor.inputSchema as SubsetSchema).required!;
      if (
        required.some((key) => !Object.hasOwn(args, key)) ||
        Object.keys(args).some((key) => !Object.hasOwn(properties, key))
      )
        return invalid();
      let identityBody: string | undefined;
      const selectedDetails: Record<string, unknown> = { ...mapping.fixed };
      if (mapping.identity) {
        if (malformedCurrentProductObservation(observations)) return invalid();
        const products = currentProducts(observations);
        const pairs: Array<{ productId: string; variantId: string | null }> =
          [];
        const titles: string[] = [];
        const aggregate = new Set<string>();
        for (const member of calls) {
          if (
            !matchesSubset(
              descriptor.inputSchema as SubsetSchema,
              member.arguments,
            ) ||
            !object(member.arguments) ||
            !Array.isArray(member.arguments.selectedPairs)
          )
            return invalid();
          const perCall = new Set<string>();
          for (const pair of member.arguments.selectedPairs) {
            if (
              !object(pair) ||
              typeof pair.productId !== "string" ||
              (pair.variantId !== null && typeof pair.variantId !== "string")
            )
              return invalid();
            const identity = canonicalJson([pair.productId, pair.variantId]);
            if (perCall.has(identity)) return invalid();
            perCall.add(identity);
            const matches = products.filter(
              (product) =>
                product.productId === pair.productId &&
                product.variantId === pair.variantId,
            );
            const agreed = new Set(matches.map((product) => product.title));
            if (
              !matches.length ||
              agreed.size !== 1 ||
              !matches[0]!.title.trim()
            )
              return invalid();
            if (!aggregate.has(identity)) {
              aggregate.add(identity);
              pairs.push({
                productId: pair.productId,
                variantId: pair.variantId,
              });
              titles.push(matches[0]!.title);
            }
          }
        }
        const pinned = details.properties![mapping.identity]!;
        if (
          pairs.length < Math.max(1, pinned.minItems ?? 0) ||
          pairs.length > Math.min(3, pinned.maxItems ?? 3)
        )
          return invalid();
        // Initial decision carries titles only, never a chosen price/stock DTO.
        // The bound production host must independently refresh before delivery.
        identityBody = titles.join("\n\n");
        selectedDetails[mapping.identity] = pairs;
      }
      for (const field of mapping.fields) selectedDetails[field] = args[field];
      for (const field of mapping.optional)
        if (Object.hasOwn(args, field)) selectedDetails[field] = args[field];
      for (const field of SELECTIONS) {
        const selected = selectedDetails[field];
        if (selected === undefined) continue;
        if (
          !Array.isArray(selected) ||
          selected.length === 0 ||
          selected.some(
            (pair) =>
              !object(pair) ||
              typeof pair.productId !== "string" ||
              (pair.variantId !== null && typeof pair.variantId !== "string"),
          )
        )
          return invalid();
        const identities = selected.map((pair) =>
          canonicalJson([pair.productId, pair.variantId]),
        );
        if (new Set(identities).size !== identities.length) return invalid();
      }
      const value = {
        answerKind: mapping.kind,
        replyText: mapping.identity ? identityBody : args.replyText,
        referralReason:
          mapping.kind === "REFER_TO_STORE" ? args.referralReason : null,
        detectedLanguageTag: mapping.identity ? null : args.detectedLanguageTag,
        detectedLanguageConfidence: mapping.identity
          ? null
          : args.detectedLanguageConfidence,
        evidenceIds:
          mapping.kind === "REFER_TO_STORE" || mapping.identity
            ? []
            : args.evidenceIds,
        details: mapping.kind === "REFER_TO_STORE" ? {} : selectedDetails,
      };
      if (
        requiredReferral &&
        (value.answerKind !== "REFER_TO_STORE" ||
          value.referralReason !== requiredReferral)
      )
        return invalid();
      const parsed = schema.safeParse(value);
      if (!parsed.success) return invalid();
      if (
        parsed.data.answerKind === "ANSWER" &&
        parsed.data.evidenceIds.length > 0
      ) {
        if (!input.hasEligibleEvidence) return invalid();
        let eligible: boolean;
        try {
          eligible = input.hasEligibleEvidence(parsed.data.evidenceIds);
        } catch {
          return invalid();
        }
        if (typeof eligible !== "boolean") return invalid();
        if (!eligible) {
          const referral = schema.safeParse({
            ...parsed.data,
            answerKind: "REFER_TO_STORE",
            referralReason: "UNVERIFIABLE_FACTS",
            evidenceIds: [],
            details: {},
          });
          return referral.success
            ? { kind: "decision", binding, value: referral.data }
            : invalid();
        }
      }
      const observedPairs = new Set(
        currentProducts(observations).map((pair) =>
          canonicalJson([pair.productId, pair.variantId]),
        ),
      );
      for (const field of SELECTIONS) {
        const selected = selectedDetails[field];
        if (
          Array.isArray(selected) &&
          selected.some(
            (pair) =>
              !observedPairs.has(
                canonicalJson([pair.productId, pair.variantId]),
              ),
          )
        )
          return invalid();
      }
      const shipping = readCommerceObservedShippingSelections(
        observations,
        input.platform,
      );
      const shippingSelection = selectedDetails.shippingInformationSelection;
      const hasShipping =
        object(shippingSelection) &&
        shipping.some(
          (pair) =>
            pair.productId === shippingSelection.productId &&
            pair.variantId === shippingSelection.variantId,
        );
      if (shippingSelection !== undefined && !hasShipping) return invalid();
      if (
        selectedDetails.responseDisposition ===
          "SHIPPING_INFORMATION_UNVERIFIED" &&
        !hasShipping &&
        !shipping.some(
          (pair) => pair.productId === null && pair.variantId === null,
        )
      )
        return invalid();
      return { kind: "decision", binding, value: parsed.data };
    },
  };
}
