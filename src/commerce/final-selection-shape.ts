import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { CommerceModelBridgeIdentifiers } from "./model-bridge-diagnostics.js";

const dispositions = new Set(["STANDARD", "OUT_OF_SCOPE_REDIRECT", "SHIPPING_INFORMATION_UNVERIFIED", "PRODUCT_DETAILS", "PRODUCT_OPTIONS"]);
const knownDetails = new Set(["productRecommendationVersion", "productRecommendations", "productDetailSelections", "productOptionSelections", "responseDisposition", "shippingInformationSelection"]);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const container = (value: unknown) => value === undefined ? "ABSENT" : value === null ? "NULL" : Array.isArray(value) ? "ARRAY" : typeof value === "object" ? "OBJECT" : "INVALID";
const arrayShape = (value: unknown) => value === undefined ? "ABSENT" : Array.isArray(value) ? "ARRAY" : "INVALID";
const count = (value: unknown) => Array.isArray(value) ? Math.min(value.length, 4) : 0;

/** Only fixed keys, enum values and capped counts leave this projection. */
export function projectFinalSelectionShape(argumentsValue: unknown) {
  const args = record(argumentsValue) ? argumentsValue : {};
  const details = record(args.details) ? args.details : {};
  let unknownDetailKeyCount = 0;
  for (const key in details) {
    if (Object.hasOwn(details, key) && !knownDetails.has(key)) {
      unknownDetailKeyCount += 1;
      if (unknownDetailKeyCount === 4) break;
    }
  }
  return {
    argumentsContainer: container(argumentsValue),
    answerKind: args.answerKind === undefined ? "ABSENT" : args.answerKind === "ANSWER" || args.answerKind === "REFER_TO_STORE" ? args.answerKind : "INVALID",
    detailsContainer: container(args.details),
    recommendationVersion: details.productRecommendationVersion === undefined ? "ABSENT" : details.productRecommendationVersion === "1" ? "V1" : "INVALID",
    recommendationArray: arrayShape(details.productRecommendations), recommendationCount: count(details.productRecommendations),
    detailArray: arrayShape(details.productDetailSelections), detailCount: count(details.productDetailSelections),
    optionArray: arrayShape(details.productOptionSelections), optionCount: count(details.productOptionSelections),
    disposition: details.responseDisposition === undefined ? "ABSENT" : typeof details.responseDisposition === "string" && dispositions.has(details.responseDisposition) ? details.responseDisposition : "INVALID",
    rawShippingSelectionPresent: Object.hasOwn(details, "shippingInformationSelection"),
    shippingSelectionContainer: container(details.shippingInformationSelection),
    unknownDetailKeyCount,
  };
}

/** Observe the original model step before either host rewriting or runner validation. */
export function logFinalSelectionShape(logger: StructuredLogger, identifiers: CommerceModelBridgeIdentifiers, step: unknown, forcedFinalResponse: boolean, responseContractHash?: string): void {
  try {
    const calls = record(step) && Array.isArray(step.calls) ? step.calls : [];
    const exactOneFinalResponse = calls.length === 1 && record(calls[0]) && calls[0].name === "finalResponse";
    logger.info("commerce.host.model_bridge.final_selection_shape", {
      ...identifiers, forcedFinalResponse,
      ...(typeof responseContractHash === "string" && /^[a-f0-9]{64}$/.test(responseContractHash) ? { responseContractHash } : {}),
      exactOneFinalResponse, callCount: Math.min(calls.length, 4),
      ...(exactOneFinalResponse ? projectFinalSelectionShape(calls[0].arguments) : {}),
    });
  } catch {
    // Diagnostics, including hostile getters or a broken sink, never alter the step.
  }
}
